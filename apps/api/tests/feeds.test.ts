import { env, SELF } from "cloudflare:test";
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
 * Intercepte le `fetch` sortant du Worker (le flux distant). `cloudflare:test`
 * de cette version n'expose pas `fetchMock` ; le Worker partageant l'isolat du
 * test, on stube le `fetch` global. `SELF.fetch` (appel du Worker) reste intact.
 */
function mockOutboundFetch(
  status: number,
  body: string,
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
<rss version="2.0"><channel><title>Flux de test</title>${items}</channel></rss>`;

const ITEM = (n: number) =>
  `<item><title>Article ${n}</title><link>https://src.example/${n}</link><guid>guid-${n}</guid><description>Résumé ${n}</description></item>`;

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  // Isolation entre tests : tables repartie de zéro (articles avant feeds — FK).
  await env.DB.prepare("DELETE FROM articles").run();
  await env.DB.prepare("DELETE FROM feeds").run();
});

describe("POST /api/feeds — abonnement", () => {
  it("refuse l'accès sans session (garde)", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/feeds`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://src.example/rss.xml" }),
    });
    expect(res.status).toBe(401);
  });

  it("s'abonne, backfille les articles en non-lu et renvoie le compte", async () => {
    mockOutboundFetch(200, RSS(`${ITEM(1)}${ITEM(2)}${ITEM(3)}`));

    const res = await SELF.fetch(
      `${ORIGIN}/api/feeds`,
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://src.example/rss.xml" }),
      }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      feed: { id: string; url: string; title: string };
      articleCount: number;
    };
    expect(body.articleCount).toBe(3);
    expect(body.feed.title).toBe("Flux de test");

    const unread = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM articles WHERE read = 0",
    ).first<{ n: number }>();
    expect(unread?.n).toBe(3);
  });

  it("backfille un flux volumineux par lots (limite D1 de variables liées)", async () => {
    // 30 items > limite d'un seul insert multi-lignes : l'insertion doit être
    // découpée en lots, sinon D1 lève « too many SQL variables ».
    const items = Array.from({ length: 30 }, (_, i) => ITEM(i)).join("");
    mockOutboundFetch(200, RSS(items));

    const res = await SELF.fetch(
      `${ORIGIN}/api/feeds`,
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://src.example/big.xml" }),
      }),
    );

    expect(res.status).toBe(201);
    expect(((await res.json()) as { articleCount: number }).articleCount).toBe(
      30,
    );
  });

  it("refuse un doublon d'abonnement (409)", async () => {
    mockOutboundFetch(200, RSS(ITEM(1)));

    const first = await SELF.fetch(
      `${ORIGIN}/api/feeds`,
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://src.example/dup.xml" }),
      }),
    );
    expect(first.status).toBe(201);

    const second = await SELF.fetch(
      `${ORIGIN}/api/feeds`,
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://src.example/dup.xml" }),
      }),
    );
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "already_subscribed" });
  });

  it("rejette un flux illisible (422)", async () => {
    mockOutboundFetch(
      200,
      "<html><body>pas un flux</body></html>",
      "text/html",
    );

    const res = await SELF.fetch(
      `${ORIGIN}/api/feeds`,
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://src.example/notafeed.html" }),
      }),
    );
    expect(res.status).toBe(422);
  });

  it("remonte un échec de fetch (502)", async () => {
    mockOutboundFetch(500, "boom", "text/plain");

    const res = await SELF.fetch(
      `${ORIGIN}/api/feeds`,
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://src.example/down.xml" }),
      }),
    );
    expect(res.status).toBe(502);
  });
});

describe("GET /api/articles?filter=unread — pagination keyset", () => {
  // 35 articles non-lus, fetched_at décroissant (art-00 = le plus récent),
  // + 1 article lu qui ne doit jamais apparaître.
  async function seed(): Promise<void> {
    const feedId = "feed-test";
    await env.DB.prepare("INSERT INTO feeds (id, url, title) VALUES (?, ?, ?)")
      .bind(feedId, "https://src.example/seed.xml", "Flux semé")
      .run();

    const base = Date.UTC(2026, 5, 5, 12, 0, 0);
    const stmt = env.DB.prepare(
      "INSERT INTO articles (id, feed_id, article_key, title, fetched_at, read) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (let i = 0; i < 35; i++) {
      const id = `art-${String(i).padStart(2, "0")}`;
      const fetchedAt = new Date(base - i * 60_000)
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z");
      await stmt
        .bind(id, feedId, `key-${i}`, `Article ${i}`, fetchedAt, 0)
        .run();
    }
    // Article lu : exclu de la vue non-lus.
    await stmt
      .bind("art-read", feedId, "key-read", "Lu", "2026-06-05T12:00:00Z", 1)
      .run();
  }

  type Page = {
    articles: { id: string; feedName: string }[];
    nextCursor: string | null;
  };

  it("pagine récent→ancien sans doublon ni trou et exclut les lus", async () => {
    await seed();

    const page1 = (await (
      await SELF.fetch(`${ORIGIN}/api/articles?filter=unread`, authed())
    ).json()) as Page;

    expect(page1.articles).toHaveLength(30);
    expect(page1.articles[0].id).toBe("art-00"); // le plus récent
    expect(page1.articles[0].feedName).toBe("Flux semé"); // jointure feed
    expect(page1.nextCursor).toBeTruthy();

    const page2 = (await (
      await SELF.fetch(
        `${ORIGIN}/api/articles?filter=unread&cursor=${encodeURIComponent(page1.nextCursor as string)}`,
        authed(),
      )
    ).json()) as Page;

    expect(page2.articles).toHaveLength(5);
    expect(page2.nextCursor).toBeNull();

    const ids = [...page1.articles, ...page2.articles].map((a) => a.id);
    expect(new Set(ids).size).toBe(35); // aucun doublon
    expect(ids).not.toContain("art-read"); // les lus sont exclus
    // Ordre global récent→ancien.
    const expected = Array.from(
      { length: 35 },
      (_, i) => `art-${String(i).padStart(2, "0")}`,
    );
    expect(ids).toEqual(expected);
  });

  it("rejette un filtre non supporté (400)", async () => {
    const res = await SELF.fetch(
      `${ORIGIN}/api/articles?filter=bogus`,
      authed(),
    );
    expect(res.status).toBe(400);
  });
});
