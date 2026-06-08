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

/** Page HTML de site, avec les `<link rel="alternate">` injectés dans `<head>`. */
const HTML = (links: string) =>
  `<!doctype html><html><head><title>Site</title>${links}</head><body></body></html>`;

const FEED_LINK = (
  href: string,
  type = "application/rss+xml",
  title?: string,
) =>
  `<link rel="alternate" type="${type}" href="${href}"${title ? ` title="${title}"` : ""}>`;

/**
 * Route le `fetch` sortant par sous-chaîne d'URL : l'auto-découverte enchaîne
 * un fetch sur l'URL de site puis (candidat unique) un fetch sur l'URL du flux,
 * qui doivent renvoyer des corps différents. Première règle qui matche gagne ;
 * 404 par défaut.
 */
function mockFetchByUrl(
  routes: {
    match: string;
    status?: number;
    body: string;
    contentType?: string;
  }[],
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : ((input as Request).url ?? String(input));
      const route = routes.find((r) => url.includes(r.match));
      if (!route) return new Response("not found", { status: 404 });
      return new Response(route.body, {
        status: route.status ?? 200,
        headers: {
          "content-type": route.contentType ?? "application/rss+xml",
        },
      });
    }),
  );
}

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

describe("POST /api/feeds/discover — auto-découverte", () => {
  const SITE = "https://site.example/blog";

  it("refuse l'accès sans session (garde)", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/feeds/discover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: SITE }),
    });
    expect(res.status).toBe(401);
  });

  it("renvoie [] quand la page n'annonce aucun flux (0 candidat)", async () => {
    mockFetchByUrl([{ match: SITE, body: HTML(""), contentType: "text/html" }]);

    const res = await SELF.fetch(
      `${ORIGIN}/api/feeds/discover`,
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: SITE }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ candidates: [] });
  });

  it("renvoie l'unique flux annoncé (1 candidat), href relatif résolu", async () => {
    mockFetchByUrl([
      {
        match: SITE,
        body: HTML(FEED_LINK("/feed.xml", "application/rss+xml", "Flux")),
        contentType: "text/html",
      },
    ]);

    const res = await SELF.fetch(
      `${ORIGIN}/api/feeds/discover`,
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: SITE }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      candidates: [
        { url: "https://site.example/feed.xml", title: "Flux", type: "rss" },
      ],
    });
  });

  it("renvoie tous les flux annoncés (N candidats)", async () => {
    mockFetchByUrl([
      {
        match: SITE,
        body: HTML(
          FEED_LINK("https://site.example/rss.xml") +
            FEED_LINK("https://site.example/atom.xml", "application/atom+xml"),
        ),
        contentType: "text/html",
      },
    ]);

    const res = await SELF.fetch(
      `${ORIGIN}/api/feeds/discover`,
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: SITE }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidates: { type: string }[] };
    expect(body.candidates).toHaveLength(2);
    expect(body.candidates.map((c) => c.type)).toEqual(["rss", "atom"]);
  });

  it("remonte un échec de fetch de la page (502)", async () => {
    mockFetchByUrl([
      { match: SITE, status: 500, body: "boom", contentType: "text/plain" },
    ]);

    const res = await SELF.fetch(
      `${ORIGIN}/api/feeds/discover`,
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: SITE }),
      }),
    );
    expect(res.status).toBe(502);
  });
});

describe("POST /api/feeds — abonnement par URL de site (#12)", () => {
  const SITE = "https://site.example/blog";
  const FEED = "https://site.example/feed.xml";

  it("URL de site à 1 candidat : s'abonne au flux découvert (201)", async () => {
    mockFetchByUrl([
      // L'URL du flux doit matcher avant l'URL de site (toutes deux sous
      // site.example) : on la place en premier.
      { match: FEED, body: RSS(`${ITEM(1)}${ITEM(2)}`) },
      { match: SITE, body: HTML(FEED_LINK(FEED)), contentType: "text/html" },
    ]);

    const res = await SELF.fetch(
      `${ORIGIN}/api/feeds`,
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: SITE }),
      }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      feed: { url: string };
      articleCount: number;
    };
    expect(body.feed.url).toBe(FEED);
    expect(body.articleCount).toBe(2);
  });

  it("URL de site à N candidats : renvoie la liste sans abonner (200)", async () => {
    mockFetchByUrl([
      {
        match: SITE,
        body: HTML(
          FEED_LINK("https://site.example/rss.xml") +
            FEED_LINK("https://site.example/atom.xml", "application/atom+xml"),
        ),
        contentType: "text/html",
      },
    ]);

    const res = await SELF.fetch(
      `${ORIGIN}/api/feeds`,
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: SITE }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidates: unknown[] };
    expect(body.candidates).toHaveLength(2);

    // Aucun Feed ne doit avoir été créé (ni le site, ni un candidat).
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM feeds",
    ).first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("URL de site sans flux : 422 no_feed_found", async () => {
    mockFetchByUrl([{ match: SITE, body: HTML(""), contentType: "text/html" }]);

    const res = await SELF.fetch(
      `${ORIGIN}/api/feeds`,
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: SITE }),
      }),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "no_feed_found" });
  });

  it("candidat unique déjà suivi : 409", async () => {
    // Pré-abonnement au flux directement.
    mockFetchByUrl([{ match: FEED, body: RSS(ITEM(1)) }]);
    const first = await SELF.fetch(
      `${ORIGIN}/api/feeds`,
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: FEED }),
      }),
    );
    expect(first.status).toBe(201);

    // L'URL de site renvoie ce même flux comme unique candidat → doublon.
    mockFetchByUrl([
      { match: FEED, body: RSS(ITEM(1)) },
      { match: SITE, body: HTML(FEED_LINK(FEED)), contentType: "text/html" },
    ]);
    const res = await SELF.fetch(
      `${ORIGIN}/api/feeds`,
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: SITE }),
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "already_subscribed" });
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
