import { env } from "cloudflare:test";
import {
  getDb,
  purgeExpiredArticles,
  runRetention,
  sweepOrphanContent,
} from "@boreas/shared";
import { beforeEach, describe, expect, it } from "vitest";

// `now` figé : la fenêtre par défaut est 60 j, donc « expiré » = avant le 1ᵉʳ avril.
const NOW = new Date("2026-05-31T12:00:00Z");
const EXPIRED = "2026-01-01T00:00:00Z"; // ~150 j → hors fenêtre
const RECENT = "2026-05-30T00:00:00Z"; // 1 j → dans la fenêtre

// Pour les tests de balayage : un `now` très postérieur à l'upload réel (horloge
// de test) des objets R2, afin de passer la période de grâce du sweep (1 h). Les
// articles purgés/épargnés ne dépendent que de `read`/`saved` ici, pas de la date.
const NOW_FUTURE = new Date("2099-01-01T00:00:00Z");

const db = getDb(env.DB);

/** Insère un Feed (idempotent) + un Article, avec son objet R2 de contenu. */
async function seedArticle(opts: {
  id: string;
  read?: boolean;
  saved?: boolean;
  fetchedAt?: string;
  contentKey?: string | null;
}): Promise<void> {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO feeds (id, url, title) VALUES (?, ?, ?)",
  )
    .bind("feed-1", "https://src.example/feed.xml", "Mon flux")
    .run();
  const contentKey =
    opts.contentKey === undefined
      ? `articles/${opts.id}.html`
      : opts.contentKey;
  await env.DB.prepare(
    "INSERT INTO articles (id, feed_id, article_key, content_key, read, saved, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      opts.id,
      "feed-1",
      `key-${opts.id}`,
      contentKey,
      opts.read ? 1 : 0,
      opts.saved ? 1 : 0,
      opts.fetchedAt ?? EXPIRED,
    )
    .run();
  if (contentKey) await env.BUCKET.put(contentKey, "<p>contenu</p>");
}

/** Vrai si l'Article existe encore en D1. */
async function articleExists(id: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 FROM articles WHERE id = ?")
    .bind(id)
    .first();
  return row !== null;
}

/** Vrai si l'objet R2 existe encore. */
async function objectExists(key: string): Promise<boolean> {
  return (await env.BUCKET.head(key)) !== null;
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM articles").run();
  await env.DB.prepare("DELETE FROM feeds").run();
  // Réinitialise la fenêtre au défaut seedé (60 j).
  await env.DB.prepare("UPDATE settings SET purge_window_days = 60").run();
  const listed = await env.BUCKET.list();
  if (listed.objects.length > 0) {
    await env.BUCKET.delete(listed.objects.map((o) => o.key));
  }
});

describe("purgeExpiredArticles", () => {
  it("purge un Read & non-Saved expiré et efface son objet R2", async () => {
    await seedArticle({ id: "a1", read: true, saved: false });

    const purged = await purgeExpiredArticles(db, env.BUCKET, NOW);

    expect(purged).toBe(1);
    expect(await articleExists("a1")).toBe(false);
    expect(await objectExists("articles/a1.html")).toBe(false);
  });

  it("ne purge jamais un Saved, même très ancien", async () => {
    await seedArticle({ id: "a1", read: true, saved: true });

    const purged = await purgeExpiredArticles(db, env.BUCKET, NOW);

    expect(purged).toBe(0);
    expect(await articleExists("a1")).toBe(true);
    expect(await objectExists("articles/a1.html")).toBe(true);
  });

  it("épargne un non-lu expiré", async () => {
    await seedArticle({ id: "a1", read: false, saved: false });

    expect(await purgeExpiredArticles(db, env.BUCKET, NOW)).toBe(0);
    expect(await articleExists("a1")).toBe(true);
  });

  it("épargne un Read & non-Saved encore dans la fenêtre", async () => {
    await seedArticle({
      id: "a1",
      read: true,
      saved: false,
      fetchedAt: RECENT,
    });

    expect(await purgeExpiredArticles(db, env.BUCKET, NOW)).toBe(0);
    expect(await articleExists("a1")).toBe(true);
  });

  it("respecte la fenêtre configurée dans settings", async () => {
    // Article à 1 j : conservé sous 60 j, purgé si la fenêtre passe à 0 j.
    await seedArticle({
      id: "a1",
      read: true,
      saved: false,
      fetchedAt: RECENT,
    });
    expect(await purgeExpiredArticles(db, env.BUCKET, NOW)).toBe(0);

    await env.DB.prepare("UPDATE settings SET purge_window_days = 0").run();
    expect(await purgeExpiredArticles(db, env.BUCKET, NOW)).toBe(1);
    expect(await articleExists("a1")).toBe(false);
  });
});

describe("sweepOrphanContent", () => {
  it("supprime un objet R2 sans ligne D1 référente", async () => {
    await env.BUCKET.put("articles/orphan.html", "<p>perdu</p>");

    const swept = await sweepOrphanContent(db, env.BUCKET, NOW_FUTURE);

    expect(swept).toBe(1);
    expect(await objectExists("articles/orphan.html")).toBe(false);
  });

  it("conserve un objet R2 encore référencé par un Article", async () => {
    await seedArticle({ id: "a1", read: false });

    const swept = await sweepOrphanContent(db, env.BUCKET, NOW_FUTURE);

    expect(swept).toBe(0);
    expect(await objectExists("articles/a1.html")).toBe(true);
  });

  it("épargne un orphelin trop récent (période de grâce, ingestion en vol)", async () => {
    await env.BUCKET.put("articles/fresh.html", "<p>frais</p>");

    // `now` au moment de l'upload : l'objet est dans la fenêtre de grâce.
    const swept = await sweepOrphanContent(db, env.BUCKET, new Date());

    expect(swept).toBe(0);
    expect(await objectExists("articles/fresh.html")).toBe(true);
  });
});

describe("runRetention", () => {
  it("purge les expirés puis balaie les orphelins, et renvoie les compteurs", async () => {
    await seedArticle({ id: "expired", read: true, saved: false }); // purgé
    await seedArticle({ id: "kept", read: false }); // conservé
    await env.BUCKET.put("articles/orphan.html", "<p>perdu</p>"); // orphelin

    // `now` futur : « expired » (read & !saved) est purgé quelle que soit sa
    // date, « kept » (non-lu) survit, et l'orphelin dépasse la période de grâce.
    const result = await runRetention(db, env.BUCKET, NOW_FUTURE);

    expect(result).toEqual({ purged: 1, sweptOrphans: 1 });
    expect(await articleExists("expired")).toBe(false);
    expect(await objectExists("articles/expired.html")).toBe(false);
    expect(await articleExists("kept")).toBe(true);
    expect(await objectExists("articles/kept.html")).toBe(true);
    expect(await objectExists("articles/orphan.html")).toBe(false);
  });
});
