import { env, SELF } from "cloudflare:test";
import { issueSession } from "@boreas/shared/crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../src/lib/session";

const SECRET = "test-secret";
const ORIGIN = "https://api.test";

function authed(init?: RequestInit): RequestInit {
  return {
    ...init,
    headers: {
      ...init?.headers,
      cookie: `${SESSION_COOKIE}=${issueSession(SECRET)}`,
    },
  };
}

/** Insère un Feed + un Article ; le contenu R2 et le Feed cible sont optionnels. */
async function seedArticle(opts: {
  id: string;
  feedId?: string;
  contentKey?: string | null;
  read?: boolean;
  saved?: boolean;
  /** Date de publication ISO, ou null (flux sans date). Défaut : null. */
  publishedAt?: string | null;
  /** Date d'ingestion ISO. Défaut : `2026-06-05T12:00:00Z`. */
  fetchedAt?: string;
}): Promise<void> {
  const feedId = opts.feedId ?? "feed-1";
  const feedTitle = feedId === "feed-1" ? "Mon flux" : `Flux ${feedId}`;
  await env.DB.prepare(
    "INSERT OR IGNORE INTO feeds (id, url, title) VALUES (?, ?, ?)",
  )
    .bind(feedId, `https://src.example/${feedId}.xml`, feedTitle)
    .run();
  await env.DB.prepare(
    "INSERT INTO articles (id, feed_id, article_key, title, link, content_key, read, saved, published_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      opts.id,
      feedId,
      `key-${opts.id}`,
      "Le vent du nord",
      "https://src.example/article",
      opts.contentKey ?? null,
      opts.read ? 1 : 0,
      opts.saved ? 1 : 0,
      opts.publishedAt ?? null,
      opts.fetchedAt ?? "2026-06-05T12:00:00Z",
    )
    .run();
}

/** Lit l'état Read d'un Article en base. */
async function readState(id: string): Promise<number | undefined> {
  const row = await env.DB.prepare("SELECT read FROM articles WHERE id = ?")
    .bind(id)
    .first<{ read: number }>();
  return row?.read;
}

/** Lit l'état Saved d'un Article en base. */
async function savedState(id: string): Promise<number | undefined> {
  const row = await env.DB.prepare("SELECT saved FROM articles WHERE id = ?")
    .bind(id)
    .first<{ saved: number }>();
  return row?.saved;
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM articles").run();
  await env.DB.prepare("DELETE FROM feeds").run();
});

describe("GET /api/articles/:id — lecteur", () => {
  it("refuse l'accès sans session (garde)", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/articles/art-1`);
    expect(res.status).toBe(401);
  });

  it("sert le contenu stocké en R2 et marque l'Article Read", async () => {
    const key = "articles/art-1.html";
    await env.BUCKET.put(key, "<p>Le vent du nord souffle.</p>");
    await seedArticle({ id: "art-1", contentKey: key });

    const res = await SELF.fetch(`${ORIGIN}/api/articles/art-1`, authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      feedName: string;
      title: string;
      link: string;
      content: string | null;
    };
    expect(body.id).toBe("art-1");
    expect(body.feedName).toBe("Mon flux");
    expect(body.content).toBe("<p>Le vent du nord souffle.</p>");

    // L'ouverture marque l'Article Read.
    const row = await env.DB.prepare("SELECT read FROM articles WHERE id = ?")
      .bind("art-1")
      .first<{ read: number }>();
    expect(row?.read).toBe(1);
  });

  it("renvoie saved + unread (unread reflète l'état AVANT le marquage Read)", async () => {
    await seedArticle({
      id: "art-su",
      contentKey: null,
      read: false,
      saved: true,
    });

    const res = await SELF.fetch(`${ORIGIN}/api/articles/art-su`, authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { saved: boolean; unread: boolean };
    // `unread` = état pré-marquage : le client sait ainsi qu'il était non-lu
    // (pour invalider les compteurs), bien que ce GET vienne de le passer Read.
    expect(body).toMatchObject({ saved: true, unread: true });
    expect(await readState("art-su")).toBe(1);
  });

  it("renvoie content:null quand l'article n'a pas de contenu extrait", async () => {
    await seedArticle({ id: "art-2", contentKey: null });

    const res = await SELF.fetch(`${ORIGIN}/api/articles/art-2`, authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string | null };
    expect(body.content).toBeNull();
  });

  it("dégrade en content:null si l'objet R2 est absent (sans 500)", async () => {
    // content_key pointe vers un objet jamais écrit en R2.
    await seedArticle({ id: "art-3", contentKey: "articles/art-3.html" });

    const res = await SELF.fetch(`${ORIGIN}/api/articles/art-3`, authed());
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { content: string | null }).content,
    ).toBeNull();
  });

  it("reste 200 et marqué lu en ré-ouvrant un article déjà lu", async () => {
    await seedArticle({ id: "art-4", contentKey: null, read: true });

    const res = await SELF.fetch(`${ORIGIN}/api/articles/art-4`, authed());
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT read FROM articles WHERE id = ?")
      .bind("art-4")
      .first<{ read: number }>();
    expect(row?.read).toBe(1);
  });

  it("renvoie 404 pour un article inconnu", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/articles/inexistant`, authed());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});

describe("GET /api/articles — filtre lus/non-lus (#8)", () => {
  it("filter=all sert lus + non-lus ; filter=unread n'en sert qu'un", async () => {
    await seedArticle({ id: "art-u", read: false });
    await seedArticle({ id: "art-r", read: true });

    const all = (await (
      await SELF.fetch(`${ORIGIN}/api/articles?filter=all`, authed())
    ).json()) as { articles: { id: string }[] };
    expect(all.articles.map((a) => a.id).sort()).toEqual(["art-r", "art-u"]);

    const unread = (await (
      await SELF.fetch(`${ORIGIN}/api/articles?filter=unread`, authed())
    ).json()) as { articles: { id: string }[] };
    expect(unread.articles.map((a) => a.id)).toEqual(["art-u"]);
  });

  it("refuse un filtre inconnu", async () => {
    const res = await SELF.fetch(
      `${ORIGIN}/api/articles?filter=bogus`,
      authed(),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unsupported_filter" });
  });
});

describe("GET /api/articles — tri par date de publication (ADR 0015)", () => {
  it("trie par published_at décroissant, indépendamment de l'ordre d'ingestion", async () => {
    // Même fetched_at (lot de backfill) : seul published_at doit départager,
    // pas l'UUID. Ordre d'insertion volontairement mélangé.
    await seedArticle({
      id: "art-old",
      publishedAt: "2026-01-01T00:00:00Z",
      fetchedAt: "2026-06-05T12:00:00Z",
    });
    await seedArticle({
      id: "art-new",
      publishedAt: "2026-06-04T00:00:00Z",
      fetchedAt: "2026-06-05T12:00:00Z",
    });
    await seedArticle({
      id: "art-mid",
      publishedAt: "2026-03-01T00:00:00Z",
      fetchedAt: "2026-06-05T12:00:00Z",
    });

    const body = (await (
      await SELF.fetch(`${ORIGIN}/api/articles?filter=all`, authed())
    ).json()) as { articles: { id: string }[] };
    expect(body.articles.map((a) => a.id)).toEqual([
      "art-new",
      "art-mid",
      "art-old",
    ]);
  });

  it("fallback sur fetched_at quand published_at est null, et expose fetchedAt", async () => {
    // art-nodate n'a pas de date de publication : il doit se trier via son
    // fetched_at (plus récent que la publication de art-dated) → en tête.
    await seedArticle({
      id: "art-dated",
      publishedAt: "2026-02-01T00:00:00Z",
      fetchedAt: "2026-06-01T00:00:00Z",
    });
    await seedArticle({
      id: "art-nodate",
      publishedAt: null,
      fetchedAt: "2026-06-09T00:00:00Z",
    });

    const body = (await (
      await SELF.fetch(`${ORIGIN}/api/articles?filter=all`, authed())
    ).json()) as {
      articles: { id: string; publishedAt: string | null; fetchedAt: string }[];
    };
    expect(body.articles.map((a) => a.id)).toEqual(["art-nodate", "art-dated"]);
    const nodate = body.articles.find((a) => a.id === "art-nodate");
    expect(nodate?.publishedAt).toBeNull();
    expect(nodate?.fetchedAt).toBe("2026-06-09T00:00:00Z");
  });

  it("pagine en keyset sans trou ni doublon, y compris published_at > fetched_at", async () => {
    // 35 articles (> PAGE_SIZE=30) aux dates de publication décroissantes et
    // distinctes ; certains publiés après leur fetch (date future relative au
    // fetch) pour stresser la clé de tri coalesce.
    const ids: string[] = [];
    for (let i = 0; i < 35; i++) {
      const id = `art-${String(i).padStart(2, "0")}`;
      ids.push(id);
      const day = String(28 - (i % 28)).padStart(2, "0");
      await seedArticle({
        id,
        publishedAt: `2026-05-${day}T${String(i).padStart(2, "0")}:00:00Z`,
        fetchedAt: "2026-04-01T00:00:00Z", // antérieur aux publications
      });
    }

    const page1 = (await (
      await SELF.fetch(`${ORIGIN}/api/articles?filter=all`, authed())
    ).json()) as { articles: { id: string }[]; nextCursor: string | null };
    expect(page1.articles).toHaveLength(30);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = (await (
      await SELF.fetch(
        `${ORIGIN}/api/articles?filter=all&cursor=${encodeURIComponent(
          page1.nextCursor as string,
        )}`,
        authed(),
      )
    ).json()) as { articles: { id: string }[]; nextCursor: string | null };
    expect(page2.articles).toHaveLength(5);
    expect(page2.nextCursor).toBeNull();

    const seen = [
      ...page1.articles.map((a) => a.id),
      ...page2.articles.map((a) => a.id),
    ];
    // Aucun doublon, tous les articles couverts exactement une fois.
    expect(new Set(seen).size).toBe(35);
    expect([...seen].sort()).toEqual([...ids].sort());
  });
});

describe("GET /api/articles?filter=saved — vue Saved (#9)", () => {
  it("ne sert que les Saved et expose l'état saved", async () => {
    await seedArticle({ id: "art-plain", saved: false });
    await seedArticle({ id: "art-saved", saved: true });

    const res = await SELF.fetch(
      `${ORIGIN}/api/articles?filter=saved`,
      authed(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      articles: { id: string; saved: boolean }[];
    };
    expect(body.articles.map((a) => a.id)).toEqual(["art-saved"]);
    expect(body.articles[0]?.saved).toBe(true);
  });

  it("expose saved aussi dans les autres filtres", async () => {
    await seedArticle({ id: "art-saved", saved: true, read: true });

    const all = (await (
      await SELF.fetch(`${ORIGIN}/api/articles?filter=all`, authed())
    ).json()) as { articles: { id: string; saved: boolean }[] };
    expect(all.articles.find((a) => a.id === "art-saved")?.saved).toBe(true);
  });
});

describe("PATCH /api/articles/:id — bascule Read (#8)", () => {
  it("marque lu puis non-lu", async () => {
    await seedArticle({ id: "art-1", read: false });

    const toRead = await SELF.fetch(
      `${ORIGIN}/api/articles/art-1`,
      authed({ method: "PATCH", body: JSON.stringify({ read: true }) }),
    );
    expect(toRead.status).toBe(200);
    expect(await toRead.json()).toEqual({ id: "art-1", read: true });
    expect(await readState("art-1")).toBe(1);

    const toUnread = await SELF.fetch(
      `${ORIGIN}/api/articles/art-1`,
      authed({ method: "PATCH", body: JSON.stringify({ read: false }) }),
    );
    expect(toUnread.status).toBe(200);
    expect(await readState("art-1")).toBe(0);
  });

  it("renvoie 404 sur un id inconnu", async () => {
    const res = await SELF.fetch(
      `${ORIGIN}/api/articles/inexistant`,
      authed({ method: "PATCH", body: JSON.stringify({ read: true }) }),
    );
    expect(res.status).toBe(404);
  });

  it("renvoie 400 sur un corps invalide", async () => {
    await seedArticle({ id: "art-1", read: false });
    const res = await SELF.fetch(
      `${ORIGIN}/api/articles/art-1`,
      authed({ method: "PATCH", body: JSON.stringify({ read: "oui" }) }),
    );
    expect(res.status).toBe(400);
  });

  it("renvoie 400 quand aucun champ n'est fourni", async () => {
    await seedArticle({ id: "art-1", read: false });
    const res = await SELF.fetch(
      `${ORIGIN}/api/articles/art-1`,
      authed({ method: "PATCH", body: JSON.stringify({}) }),
    );
    expect(res.status).toBe(400);
  });

  it("refuse l'accès sans session (garde)", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/articles/art-1`, {
      method: "PATCH",
      body: JSON.stringify({ read: true }),
    });
    expect(res.status).toBe(401);
  });
});

describe("PATCH /api/articles/:id — bascule Saved (#9)", () => {
  it("sauve puis désauve, sans toucher l'état Read", async () => {
    await seedArticle({ id: "art-1", read: false, saved: false });

    const toSaved = await SELF.fetch(
      `${ORIGIN}/api/articles/art-1`,
      authed({ method: "PATCH", body: JSON.stringify({ saved: true }) }),
    );
    expect(toSaved.status).toBe(200);
    expect(await toSaved.json()).toEqual({ id: "art-1", saved: true });
    expect(await savedState("art-1")).toBe(1);
    expect(await readState("art-1")).toBe(0);

    const toUnsaved = await SELF.fetch(
      `${ORIGIN}/api/articles/art-1`,
      authed({ method: "PATCH", body: JSON.stringify({ saved: false }) }),
    );
    expect(toUnsaved.status).toBe(200);
    expect(await savedState("art-1")).toBe(0);
  });

  it("bascule read et saved dans une même requête", async () => {
    await seedArticle({ id: "art-1", read: false, saved: false });

    const res = await SELF.fetch(
      `${ORIGIN}/api/articles/art-1`,
      authed({
        method: "PATCH",
        body: JSON.stringify({ read: true, saved: true }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "art-1", read: true, saved: true });
    expect(await readState("art-1")).toBe(1);
    expect(await savedState("art-1")).toBe(1);
  });

  it("renvoie 404 sur un id inconnu", async () => {
    const res = await SELF.fetch(
      `${ORIGIN}/api/articles/inexistant`,
      authed({ method: "PATCH", body: JSON.stringify({ saved: true }) }),
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/articles/mark-read — tout marquer lu (#8)", () => {
  it("portée global marque tous les non-lus et compte les bascules", async () => {
    await seedArticle({ id: "a1", feedId: "feed-1", read: false });
    await seedArticle({ id: "a2", feedId: "feed-2", read: false });
    await seedArticle({ id: "a3", feedId: "feed-2", read: true });

    const res = await SELF.fetch(
      `${ORIGIN}/api/articles/mark-read`,
      authed({ method: "POST", body: JSON.stringify({ scope: "global" }) }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 2 });
    expect(await readState("a1")).toBe(1);
    expect(await readState("a2")).toBe(1);
  });

  it("portée feed ne touche que le Feed ciblé", async () => {
    await seedArticle({ id: "a1", feedId: "feed-1", read: false });
    await seedArticle({ id: "a2", feedId: "feed-2", read: false });

    const res = await SELF.fetch(
      `${ORIGIN}/api/articles/mark-read`,
      authed({
        method: "POST",
        body: JSON.stringify({ scope: "feed", feedId: "feed-1" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 1 });
    expect(await readState("a1")).toBe(1);
    expect(await readState("a2")).toBe(0);
  });

  it("renvoie 400 sur une portée invalide", async () => {
    const res = await SELF.fetch(
      `${ORIGIN}/api/articles/mark-read`,
      authed({ method: "POST", body: JSON.stringify({ scope: "folder" }) }),
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/articles/counts — compteurs non-lus (#8)", () => {
  it("expose le total global et l'agrégat par Feed (non-lus seuls)", async () => {
    await seedArticle({ id: "a1", feedId: "feed-1", read: false });
    await seedArticle({ id: "a2", feedId: "feed-1", read: false });
    await seedArticle({ id: "a3", feedId: "feed-1", read: true });
    await seedArticle({ id: "a4", feedId: "feed-2", read: false });

    const res = await SELF.fetch(`${ORIGIN}/api/articles/counts`, authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      byFeed: { feedId: string; count: number }[];
    };
    expect(body.total).toBe(3);
    const byFeed = Object.fromEntries(
      body.byFeed.map((row) => [row.feedId, row.count]),
    );
    expect(byFeed).toEqual({ "feed-1": 2, "feed-2": 1 });
  });

  it("n'est pas capturé par la route /:id", async () => {
    // Sans articles, /counts renvoie un total nul — et surtout pas un 404
    // « article inconnu » qui signalerait une capture par GET /:id.
    const res = await SELF.fetch(`${ORIGIN}/api/articles/counts`, authed());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ total: 0, byFeed: [], byFolder: [] });
  });
});

describe("Feeds désabonnés (#14) — exclusion des vues non-lus", () => {
  /** Insère un Feed déjà marqué désabonné. */
  async function seedUnsubscribedFeed(): Promise<void> {
    await env.DB.prepare(
      "INSERT INTO feeds (id, url, title, unsubscribed_at) VALUES (?, ?, ?, ?)",
    )
      .bind(
        "feed-off",
        "https://src.example/off.xml",
        "Flux désabonné",
        "2026-06-01T00:00:00Z",
      )
      .run();
  }

  it("exclut un Saved+non-lu d'un feed désabonné des vues unread/all/compteurs, mais le garde dans Saved", async () => {
    await seedUnsubscribedFeed();
    // Saved + non-lu dans le feed désabonné (cas typique : article gardé).
    await seedArticle({
      id: "art-off",
      feedId: "feed-off",
      saved: true,
      read: false,
    });
    // Témoin : un non-lu dans un feed actif.
    await seedArticle({ id: "art-on", feedId: "feed-1", read: false });

    const unread = (await (
      await SELF.fetch(`${ORIGIN}/api/articles?filter=unread`, authed())
    ).json()) as { articles: { id: string }[] };
    expect(unread.articles.map((a) => a.id)).toEqual(["art-on"]);

    const all = (await (
      await SELF.fetch(`${ORIGIN}/api/articles?filter=all`, authed())
    ).json()) as { articles: { id: string }[] };
    expect(all.articles.map((a) => a.id)).not.toContain("art-off");

    // La vue Saved, elle, conserve l'article du feed désabonné.
    const saved = (await (
      await SELF.fetch(`${ORIGIN}/api/articles?filter=saved`, authed())
    ).json()) as { articles: { id: string }[] };
    expect(saved.articles.map((a) => a.id)).toContain("art-off");

    const counts = (await (
      await SELF.fetch(`${ORIGIN}/api/articles/counts`, authed())
    ).json()) as { total: number; byFeed: { feedId: string }[] };
    expect(counts.total).toBe(1);
    expect(counts.byFeed.map((b) => b.feedId)).not.toContain("feed-off");
  });
});
