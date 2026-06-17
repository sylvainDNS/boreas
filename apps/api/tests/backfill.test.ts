import { env, SELF } from "cloudflare:test";
import { backfillFeed, getDb } from "@boreas/shared";
import { issueSession } from "@boreas/shared/crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

/**
 * Stube le `fetch` sortant (le flux distant). `cloudflare:test` partage l'isolat
 * du test : on remplace le `fetch` global, `SELF.fetch` (appel du Worker) reste
 * intact. Le backfill ne pose pas d'en-têtes conditionnels → un seul corps suffit.
 */
function mockOutboundFetch(
  body: string,
  status = 200,
  contentType = "application/rss+xml",
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(body, {
          status,
          headers: { "content-type": contentType },
        }),
    ),
  );
}

const RSS = (items: string) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel><title>Flux de test</title>${items}</channel></rss>`;

/** Item RSS avec un `content:encoded` (CDATA) arbitraire et un guid stable. */
const ITEM = (guid: string, encoded: string) =>
  `<item><title>${guid}</title><link>https://src.example/${guid}</link>` +
  `<guid>${guid}</guid>` +
  `<content:encoded><![CDATA[${encoded}]]></content:encoded></item>`;

/** Item RSS sans aucun contenu (ni content:encoded ni description). */
const ITEM_NO_CONTENT = (guid: string) =>
  `<item><title>${guid}</title><link>https://src.example/${guid}</link><guid>${guid}</guid></item>`;

const FEED_ID = "feed-1";
const FEED_URL = "https://src.example/feed.xml";

/** Insère le Feed actif de test. */
async function seedFeed(): Promise<void> {
  await env.DB.prepare("INSERT INTO feeds (id, url, title) VALUES (?, ?, ?)")
    .bind(FEED_ID, FEED_URL, "Flux de test")
    .run();
}

/**
 * Insère un article existant avec un état Read/Saved et un `updated_at` contrôlés.
 * Pré-écrit son objet R2 (contenu « ancien ») sauf si `contentKey: null` simule
 * un article dont l'extraction avait échoué à l'ingestion (aucun contenu stocké).
 */
async function seedArticle(opts: {
  id: string;
  guid: string;
  read?: boolean;
  saved?: boolean;
  fetchedAt?: string;
  updatedAt?: number;
  oldBody?: string;
  contentKey?: string | null;
}): Promise<void> {
  const fetchedAt = opts.fetchedAt ?? "2025-01-01T00:00:00Z";
  const contentKey =
    opts.contentKey === undefined
      ? `articles/${opts.id}.html`
      : opts.contentKey;
  await env.DB.prepare(
    `INSERT INTO articles
       (id, feed_id, article_key, title, link, content_key, read, saved, fetched_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      opts.id,
      FEED_ID,
      `guid:${opts.guid}`,
      opts.guid,
      `https://src.example/${opts.guid}`,
      contentKey,
      opts.read ? 1 : 0,
      opts.saved ? 1 : 0,
      fetchedAt,
      fetchedAt,
      opts.updatedAt ?? 1000,
    )
    .run();
  if (contentKey !== null) {
    await env.BUCKET.put(
      `articles/${opts.id}.html`,
      opts.oldBody ?? "<p>old</p>",
    );
  }
}

async function r2Text(key: string): Promise<string | null> {
  const obj = await env.BUCKET.get(key);
  return obj ? await obj.text() : null;
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM articles").run();
  await env.DB.prepare("DELETE FROM feeds").run();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("backfillFeed (#97)", () => {
  it("ré-sanitize en place un article existant et récupère ses embeds, sans toucher à l'identité ni Read/Saved", async () => {
    await seedFeed();
    await seedArticle({
      id: "art-iframe",
      guid: "g-iframe",
      read: true,
      saved: true,
    });
    await seedArticle({ id: "art-picture", guid: "g-picture" });

    mockOutboundFetch(
      RSS(
        ITEM(
          "g-iframe",
          '<p>Texte</p><iframe src="https://www.youtube-nocookie.com/embed/abc123"></iframe>',
        ) +
          ITEM(
            "g-picture",
            '<picture><source type="image/webp" srcset="https://img.example/a.webp"><img src="https://img.example/a.jpg" alt="photo"></picture>',
          ),
      ),
    );

    const result = await backfillFeed(
      FEED_ID,
      getDb(env.DB),
      env.BUCKET,
      SECRET,
    );

    expect(result.status).toBe("updated");
    expect(result.rewritten).toBe(2);

    // #94 : l'iframe YouTube survit désormais à la ré-sanitization.
    const iframeHtml = await r2Text("articles/art-iframe.html");
    expect(iframeHtml).toContain("<iframe");
    expect(iframeHtml).toContain("youtube-nocookie.com/embed/abc123");

    // #95 : l'image en <picture> est conservée et proxifiée via /api/img.
    const pictureHtml = await r2Text("articles/art-picture.html");
    expect(pictureHtml).toContain("<img");
    expect(pictureHtml).toContain("/api/img");

    // Identité + état utilisateur préservés ; aucun doublon.
    const row = await env.DB.prepare(
      "SELECT read, saved, fetched_at, content_key, updated_at FROM articles WHERE id = ?",
    )
      .bind("art-iframe")
      .first<{
        read: number;
        saved: number;
        fetched_at: string;
        content_key: string;
        updated_at: number;
      }>();
    expect(row?.read).toBe(1);
    expect(row?.saved).toBe(1);
    expect(row?.fetched_at).toBe("2025-01-01T00:00:00Z");
    expect(row?.content_key).toBe("articles/art-iframe.html");
    // #69 : updated_at bumpé → le delta sync re-pousse le contenu au réplica.
    expect(row?.updated_at).toBeGreaterThan(1000);

    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM articles",
    ).first<{ n: number }>();
    expect(count?.n).toBe(2);
  });

  it("ignore les items du flux dont l'article n'existe pas (aucun net-new inséré)", async () => {
    await seedFeed();
    await seedArticle({ id: "art-1", guid: "g-1" });

    mockOutboundFetch(
      RSS(
        ITEM("g-1", "<p>maj</p>") +
          ITEM("g-2", "<p>nouvel item jamais stocké</p>"),
      ),
    );

    const result = await backfillFeed(
      FEED_ID,
      getDb(env.DB),
      env.BUCKET,
      SECRET,
    );

    expect(result.rewritten).toBe(1);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM articles",
    ).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("préserve l'objet R2 existant quand la ré-extraction ne produit rien (pas d'écrasement)", async () => {
    await seedFeed();
    await seedArticle({
      id: "art-1",
      guid: "g-1",
      oldBody: "<p>contenu précieux</p>",
      updatedAt: 1000,
    });

    mockOutboundFetch(RSS(ITEM_NO_CONTENT("g-1")));

    const result = await backfillFeed(
      FEED_ID,
      getDb(env.DB),
      env.BUCKET,
      SECRET,
    );

    expect(result.rewritten).toBe(0);
    expect(await r2Text("articles/art-1.html")).toBe("<p>contenu précieux</p>");
    const row = await env.DB.prepare(
      "SELECT updated_at FROM articles WHERE id = ?",
    )
      .bind("art-1")
      .first<{ updated_at: number }>();
    // Aucune réécriture → updated_at inchangé (pas de re-push inutile au réplica).
    expect(row?.updated_at).toBe(1000);
  });

  it("pose content_key pour un article dont l'extraction avait échoué à l'ingestion", async () => {
    await seedFeed();
    await seedArticle({ id: "art-orphan", guid: "g-1", contentKey: null });

    mockOutboundFetch(RSS(ITEM("g-1", "<p>contenu enfin extractible</p>")));

    const result = await backfillFeed(
      FEED_ID,
      getDb(env.DB),
      env.BUCKET,
      SECRET,
    );

    expect(result.rewritten).toBe(1);
    expect(await r2Text("articles/art-orphan.html")).toContain("contenu enfin");
    const row = await env.DB.prepare(
      "SELECT content_key FROM articles WHERE id = ?",
    )
      .bind("art-orphan")
      .first<{ content_key: string | null }>();
    expect(row?.content_key).toBe("articles/art-orphan.html");
  });

  it("déduplique les items au guid dupliqué : un seul article réécrit, pas de sur-comptage", async () => {
    await seedFeed();
    await seedArticle({ id: "art-1", guid: "dup" });

    // Deux items partageant le même guid → même article_key → même article.
    mockOutboundFetch(RSS(ITEM("dup", "<p>v1</p>") + ITEM("dup", "<p>v2</p>")));

    const result = await backfillFeed(
      FEED_ID,
      getDb(env.DB),
      env.BUCKET,
      SECRET,
    );

    expect(result.rewritten).toBe(1);
  });

  it("renvoie status:error si le Feed est introuvable, sans rien réécrire", async () => {
    mockOutboundFetch(RSS(ITEM("g-1", "<p>x</p>")));

    const result = await backfillFeed(
      "inconnu",
      getDb(env.DB),
      env.BUCKET,
      SECRET,
    );

    expect(result.status).toBe("error");
    expect(result.error).toBe("feed_not_found");
    expect(result.rewritten).toBe(0);
  });

  it("renvoie status:error sur un fetch non-2xx, sans rien réécrire", async () => {
    await seedFeed();
    await seedArticle({ id: "art-1", guid: "g-1", oldBody: "<p>intact</p>" });
    mockOutboundFetch("oops", 500);

    const result = await backfillFeed(
      FEED_ID,
      getDb(env.DB),
      env.BUCKET,
      SECRET,
    );

    expect(result.status).toBe("error");
    expect(result.error).toBe("http_500");
    expect(result.rewritten).toBe(0);
    expect(await r2Text("articles/art-1.html")).toBe("<p>intact</p>");
  });
});

describe("POST /api/backfill (#97)", () => {
  it("refuse l'accès sans session (garde)", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/backfill`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("enqueue les feeds actifs et exclut les désabonnés", async () => {
    await env.DB.prepare("INSERT INTO feeds (id, url, title) VALUES (?, ?, ?)")
      .bind("active-1", "https://src.example/1.xml", "Actif 1")
      .run();
    await env.DB.prepare("INSERT INTO feeds (id, url, title) VALUES (?, ?, ?)")
      .bind("active-2", "https://src.example/2.xml", "Actif 2")
      .run();
    await env.DB.prepare(
      "INSERT INTO feeds (id, url, title, unsubscribed_at) VALUES (?, ?, ?, ?)",
    )
      .bind(
        "gone",
        "https://src.example/3.xml",
        "Désabonné",
        "2026-01-01T00:00:00Z",
      )
      .run();

    const res = await SELF.fetch(
      `${ORIGIN}/api/backfill`,
      authed({ method: "POST" }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enqueued: 2 });
  });
});
