import { env, SELF } from "cloudflare:test";
import { getDb, getDueFeedIds } from "@boreas/shared";
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

/** Lit le tombstone d'une entité (deleted_at epoch-ms), ou undefined. */
async function tombstone(
  entityType: string,
  entityId: string,
): Promise<number | undefined> {
  const row = await env.DB.prepare(
    "SELECT deleted_at FROM tombstones WHERE entity_type = ? AND entity_id = ?",
  )
    .bind(entityType, entityId)
    .first<{ deleted_at: number }>();
  return row?.deleted_at;
}

/** Lit `updated_at` (epoch-ms) d'un Feed. */
async function feedUpdatedAt(id: string): Promise<number | undefined> {
  const row = await env.DB.prepare("SELECT updated_at FROM feeds WHERE id = ?")
    .bind(id)
    .first<{ updated_at: number }>();
  return row?.updated_at;
}

beforeEach(async () => {
  // Isolation entre tests : tables repartie de zéro (articles avant feeds — FK).
  await env.DB.prepare("DELETE FROM tombstones").run();
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

describe("Rang lexorank des Feeds (#110, ADR 0020)", () => {
  /** Insère un Feed avec un rang explicite, éventuellement rattaché à un Folder. */
  async function seedFeed(
    id: string,
    opts: { title?: string; folderId?: string | null; rank?: string } = {},
  ): Promise<void> {
    await env.DB.prepare(
      "INSERT INTO feeds (id, url, title, folder_id, rank) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(
        id,
        `https://src.example/${id}.xml`,
        opts.title ?? `Flux ${id}`,
        opts.folderId ?? null,
        opts.rank ?? `a${id}`,
      )
      .run();
  }

  /** Insère un Folder (rang non pertinent pour ces tests). */
  async function seedFolder(id: string): Promise<void> {
    await env.DB.prepare(
      "INSERT INTO folders (id, name, rank) VALUES (?, ?, ?)",
    )
      .bind(id, `Dossier ${id}`, `a${id}`)
      .run();
  }

  /** Lit le rang d'un Feed en base. */
  async function feedRank(id: string): Promise<string> {
    const row = await env.DB.prepare("SELECT rank AS r FROM feeds WHERE id = ?")
      .bind(id)
      .first<{ r: string }>();
    if (!row) throw new Error(`feed ${id} introuvable`);
    return row.r;
  }

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM articles").run();
    await env.DB.prepare("DELETE FROM feeds").run();
    await env.DB.prepare("DELETE FROM folders").run();
  });

  it("GET /api/feeds trie par rang au sein d'un conteneur et expose `rank`", async () => {
    // Zone « sans dossier » : deux feeds dont le rang ne suit PAS l'ordre alpha.
    await seedFeed("z-feed", { title: "Zèbre", rank: "a0" });
    await seedFeed("a-feed", { title: "Abeille", rank: "a1" });

    const res = await SELF.fetch(`${ORIGIN}/api/feeds`, authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      feeds: { id: string; rank: string }[];
    };
    // Tri par rang (et non par titre) : a0 (Zèbre) avant a1 (Abeille).
    expect(body.feeds.map((f) => f.id)).toEqual(["z-feed", "a-feed"]);
    expect(body.feeds[0].rank).toBe("a0");
    expect(body.feeds[1].rank).toBe("a1");
  });

  it("POST /api/feeds place le nouveau Feed en fin de la zone « sans dossier »", async () => {
    // Un Feed déjà classé dans un Folder avec un rang « haut » ne doit PAS borner
    // le rang du nouvel abonné (scoping par conteneur, ADR 0020).
    await seedFolder("fold-1");
    await seedFeed("classed", { folderId: "fold-1", rank: "z9" });
    await seedFeed("loose", { folderId: null, rank: "a0" });

    mockOutboundFetch(200, RSS(ITEM(1)));
    const res = await SELF.fetch(
      `${ORIGIN}/api/feeds`,
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://src.example/new.xml" }),
      }),
    );
    expect(res.status).toBe(201);
    const { feed } = (await res.json()) as { feed: { id: string } };

    const newRank = await feedRank(feed.id);
    // Placé après le dernier rang de la zone sans-dossier (a0), pas après z9.
    expect(newRank > "a0").toBe(true);
    expect(newRank < "z9").toBe(true);
  });

  it("PATCH /api/feeds/:id déplaçant vers un Folder réattribue un rang en fin du conteneur cible", async () => {
    await seedFolder("fold-1");
    // Conteneur cible déjà peuplé : un Feed de rang « a5 » dans fold-1.
    await seedFeed("resident", { folderId: "fold-1", rank: "a5" });
    // Feed à déplacer, hors dossier, rang « z0 » (plus haut que la cible).
    await seedFeed("mover", { folderId: null, rank: "z0" });

    const res = await SELF.fetch(
      `${ORIGIN}/api/feeds/mover`,
      authed({ method: "PATCH", body: JSON.stringify({ folderId: "fold-1" }) }),
    );
    expect(res.status).toBe(200);

    const movedRank = await feedRank("mover");
    // Réattribué en fin du conteneur cible (après a5), pas conservé à z0.
    expect(movedRank > "a5").toBe(true);
    expect(movedRank).not.toBe("z0");
  });

  it("PATCH /api/feeds/:id désassignant (folderId null) réattribue en fin de la zone sans-dossier", async () => {
    await seedFolder("fold-1");
    await seedFeed("loose", { folderId: null, rank: "a0" });
    await seedFeed("mover", { folderId: "fold-1", rank: "z0" });

    const res = await SELF.fetch(
      `${ORIGIN}/api/feeds/mover`,
      authed({ method: "PATCH", body: JSON.stringify({ folderId: null }) }),
    );
    expect(res.status).toBe(200);

    const movedRank = await feedRank("mover");
    expect(movedRank > "a0").toBe(true);
    expect(movedRank).not.toBe("z0");
  });

  it("PATCH /api/feeds/:id (renommage seul) ne touche pas le rang", async () => {
    await seedFeed("feed-1", { title: "Avant", folderId: null, rank: "a3" });

    const res = await SELF.fetch(
      `${ORIGIN}/api/feeds/feed-1`,
      authed({ method: "PATCH", body: JSON.stringify({ title: "Après" }) }),
    );
    expect(res.status).toBe(200);
    expect(await feedRank("feed-1")).toBe("a3");
  });

  it("PATCH /api/feeds/:id écrit un `rank` explicite verbatim sans toucher folder_id (#111)", async () => {
    await seedFolder("fold-1");
    await seedFeed("feed-1", { folderId: "fold-1", rank: "a5" });

    const res = await SELF.fetch(
      `${ORIGIN}/api/feeds/feed-1`,
      authed({ method: "PATCH", body: JSON.stringify({ rank: "a3" }) }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; rank?: string };
    expect(body.rank).toBe("a3");
    // Rang écrit verbatim (pas de rééquilibrage) ; le conteneur reste fold-1.
    expect(await feedRank("feed-1")).toBe("a3");
    const row = await env.DB.prepare(
      "SELECT folder_id AS f FROM feeds WHERE id = ?",
    )
      .bind("feed-1")
      .first<{ f: string | null }>();
    expect(row?.f).toBe("fold-1");
  });

  it("PATCH /api/feeds/:id avec {folderId, rank} : le rang explicite prime sur la réattribution auto (#111/#112)", async () => {
    await seedFolder("fold-1");
    await seedFeed("resident", { folderId: "fold-1", rank: "a5" });
    await seedFeed("mover", { folderId: null, rank: "z0" });

    const res = await SELF.fetch(
      `${ORIGIN}/api/feeds/mover`,
      authed({
        method: "PATCH",
        body: JSON.stringify({ folderId: "fold-1", rank: "a3" }),
      }),
    );
    expect(res.status).toBe(200);
    // Conteneur changé ET rang explicite respecté (a3, pas une fin de conteneur).
    expect(await feedRank("mover")).toBe("a3");
    const row = await env.DB.prepare(
      "SELECT folder_id AS f FROM feeds WHERE id = ?",
    )
      .bind("mover")
      .first<{ f: string | null }>();
    expect(row?.f).toBe("fold-1");
  });

  it("PATCH /api/feeds/:id renvoie 404 sur un feed inconnu (rank seul)", async () => {
    const res = await SELF.fetch(
      `${ORIGIN}/api/feeds/inconnu`,
      authed({ method: "PATCH", body: JSON.stringify({ rank: "a3" }) }),
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/feeds — abonnement dans un dossier (#117)", () => {
  /** Insère un Folder (rang non pertinent ici). */
  async function seedFolder(id: string): Promise<void> {
    await env.DB.prepare(
      "INSERT INTO folders (id, name, rank) VALUES (?, ?, ?)",
    )
      .bind(id, `Dossier ${id}`, `a${id}`)
      .run();
  }

  /** Insère un Feed avec rang explicite, éventuellement classé. */
  async function seedFeed(
    id: string,
    opts: { folderId?: string | null; rank?: string } = {},
  ): Promise<void> {
    await env.DB.prepare(
      "INSERT INTO feeds (id, url, title, folder_id, rank, unsubscribed_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(
        id,
        `https://src.example/${id}.xml`,
        `Flux ${id}`,
        opts.folderId ?? null,
        opts.rank ?? `a${id}`,
        null,
      )
      .run();
  }

  /** Lit (folder_id, rank) d'un Feed. */
  async function feedContainer(
    id: string,
  ): Promise<{ folderId: string | null; rank: string }> {
    const row = await env.DB.prepare(
      "SELECT folder_id AS f, rank AS r FROM feeds WHERE id = ?",
    )
      .bind(id)
      .first<{ f: string | null; r: string }>();
    if (!row) throw new Error(`feed ${id} introuvable`);
    return { folderId: row.f, rank: row.r };
  }

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM articles").run();
    await env.DB.prepare("DELETE FROM feeds").run();
    await env.DB.prepare("DELETE FROM folders").run();
  });

  it("crée le Feed dans le Folder fourni (GET le confirme)", async () => {
    await seedFolder("fold-1");
    mockOutboundFetch(200, RSS(ITEM(1)));

    const res = await SELF.fetch(
      `${ORIGIN}/api/feeds`,
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: "https://src.example/inf.xml",
          folderId: "fold-1",
        }),
      }),
    );
    expect(res.status).toBe(201);
    // La 201 n'écho PAS folderId (décision #117).
    const body = (await res.json()) as {
      feed: { id: string; folderId?: unknown };
    };
    expect(body.feed.folderId).toBeUndefined();

    const list = (await (
      await SELF.fetch(`${ORIGIN}/api/feeds`, authed())
    ).json()) as { feeds: { id: string; folderId: string | null }[] };
    const created = list.feeds.find((f) => f.id === body.feed.id);
    expect(created?.folderId).toBe("fold-1");
  });

  it("deux Feeds dans le même Folder → rangs croissants et scopés au conteneur", async () => {
    await seedFolder("fold-1");
    // Un Feed hors dossier avec un rang « haut » ne doit pas borner la cible.
    await seedFeed("loose", { folderId: null, rank: "z9" });

    mockOutboundFetch(200, RSS(ITEM(1)));
    const r1 = await SELF.fetch(
      `${ORIGIN}/api/feeds`,
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: "https://src.example/one.xml",
          folderId: "fold-1",
        }),
      }),
    );
    const id1 = ((await r1.json()) as { feed: { id: string } }).feed.id;

    mockOutboundFetch(200, RSS(ITEM(2)));
    const r2 = await SELF.fetch(
      `${ORIGIN}/api/feeds`,
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: "https://src.example/two.xml",
          folderId: "fold-1",
        }),
      }),
    );
    const id2 = ((await r2.json()) as { feed: { id: string } }).feed.id;

    const c1 = await feedContainer(id1);
    const c2 = await feedContainer(id2);
    expect(c1.folderId).toBe("fold-1");
    expect(c2.folderId).toBe("fold-1");
    // Rangs croissants au sein du conteneur, non bornés par le « loose » (z9).
    expect(c2.rank > c1.rank).toBe(true);
    expect(c1.rank < "z9").toBe(true);
  });

  it("folderId inexistant → 422 folder_not_found, aucun Feed créé ni fetch", async () => {
    const outbound = vi.fn(
      async () => new Response(RSS(ITEM(1)), { status: 200 }),
    );
    vi.stubGlobal("fetch", outbound);

    const res = await SELF.fetch(
      `${ORIGIN}/api/feeds`,
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: "https://src.example/nope.xml",
          folderId: "ghost",
        }),
      }),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "folder_not_found" });

    // Aucun fetch sortant, aucun Feed créé.
    expect(outbound).not.toHaveBeenCalled();
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM feeds",
    ).first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("sans folderId : comportement inchangé (NULL, rang zone sans-dossier)", async () => {
    await seedFolder("fold-1");
    await seedFeed("classed", { folderId: "fold-1", rank: "z9" });
    await seedFeed("loose", { folderId: null, rank: "a0" });

    mockOutboundFetch(200, RSS(ITEM(1)));
    const res = await SELF.fetch(
      `${ORIGIN}/api/feeds`,
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://src.example/free.xml" }),
      }),
    );
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { feed: { id: string } }).feed.id;
    const c = await feedContainer(id);
    expect(c.folderId).toBeNull();
    // Placé en fin de la zone sans-dossier (après a0), pas après z9 du Folder.
    expect(c.rank > "a0").toBe(true);
    expect(c.rank < "z9").toBe(true);
  });

  it("candidat unique (#12) atterrit dans le Folder fourni", async () => {
    const SITE = "https://site.example/blog";
    const FEED = "https://site.example/feed.xml";
    await seedFolder("fold-1");
    mockFetchByUrl([
      { match: FEED, body: RSS(ITEM(1)) },
      { match: SITE, body: HTML(FEED_LINK(FEED)), contentType: "text/html" },
    ]);

    const res = await SELF.fetch(
      `${ORIGIN}/api/feeds`,
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: SITE, folderId: "fold-1" }),
      }),
    );
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { feed: { id: string } }).feed.id;
    expect((await feedContainer(id)).folderId).toBe("fold-1");
  });

  it("multi-candidats (#12) → 200 inchangé (folderId ignoré, aucun Feed)", async () => {
    const SITE = "https://site.example/blog";
    await seedFolder("fold-1");
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
        body: JSON.stringify({ url: SITE, folderId: "fold-1" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidates: unknown[] };
    expect(body.candidates).toHaveLength(2);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM feeds",
    ).first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("réabonnement + folderId → réactivé, réassigné et rangé en fin du conteneur cible", async () => {
    await seedFolder("fold-1");
    // Conteneur cible déjà peuplé : un résident rang « a5 ».
    await seedFeed("resident", { folderId: "fold-1", rank: "a5" });
    // Feed désabonné, hors dossier, rang « z0 ».
    const url = "https://src.example/re.xml";
    await env.DB.prepare(
      "INSERT INTO feeds (id, url, title, folder_id, rank, unsubscribed_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind("dead", url, "Mort", null, "z0", "2026-06-01T00:00:00Z")
      .run();

    mockOutboundFetch(200, RSS(`${ITEM(1)}${ITEM(2)}`));
    const res = await SELF.fetch(
      `${ORIGIN}/api/feeds`,
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, folderId: "fold-1" }),
      }),
    );
    expect(res.status).toBe(201);
    const c = await feedContainer("dead");
    // Réassigné au conteneur cible et rangé après le résident (a5).
    expect(c.folderId).toBe("fold-1");
    expect(c.rank > "a5").toBe(true);
    expect(c.rank).not.toBe("z0");
    // Réactivé.
    const row = await env.DB.prepare(
      "SELECT unsubscribed_at AS u FROM feeds WHERE id = ?",
    )
      .bind("dead")
      .first<{ u: string | null }>();
    expect(row?.u).toBeNull();
  });

  it("réabonnement sans folderId → conserve son dossier d'origine", async () => {
    await seedFolder("fold-1");
    const url = "https://src.example/keep.xml";
    await env.DB.prepare(
      "INSERT INTO feeds (id, url, title, folder_id, rank, unsubscribed_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind("kept", url, "Gardé", "fold-1", "a5", "2026-06-01T00:00:00Z")
      .run();

    mockOutboundFetch(200, RSS(ITEM(1)));
    const res = await SELF.fetch(
      `${ORIGIN}/api/feeds`,
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      }),
    );
    expect(res.status).toBe(201);
    const c = await feedContainer("kept");
    // Dossier conservé, rang inchangé (on ne re-ranke pas sans folderId).
    expect(c.folderId).toBe("fold-1");
    expect(c.rank).toBe("a5");
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

describe("Cycle de vie d'un Feed (#14) — unsubscribe & delete", () => {
  async function seedFeed(
    id: string,
    opts: { unsubscribedAt?: string | null } = {},
  ): Promise<void> {
    await env.DB.prepare(
      "INSERT INTO feeds (id, url, title, unsubscribed_at) VALUES (?, ?, ?, ?)",
    )
      .bind(
        id,
        `https://src.example/${id}.xml`,
        `Flux ${id}`,
        opts.unsubscribedAt ?? null,
      )
      .run();
  }

  async function seedArticle(
    id: string,
    feedId: string,
    opts: { saved?: boolean; contentKey?: string | null } = {},
  ): Promise<void> {
    await env.DB.prepare(
      "INSERT INTO articles (id, feed_id, article_key, title, content_key, saved, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        id,
        feedId,
        `key-${id}`,
        `Art ${id}`,
        opts.contentKey ?? null,
        opts.saved ? 1 : 0,
        "2026-06-05T12:00:00Z",
      )
      .run();
    if (opts.contentKey) await env.BUCKET.put(opts.contentKey, "<p>x</p>");
  }

  async function rowExists(table: string, id: string): Promise<boolean> {
    const row = await env.DB.prepare(`SELECT 1 AS n FROM ${table} WHERE id = ?`)
      .bind(id)
      .first();
    return row != null;
  }

  async function r2Exists(key: string): Promise<boolean> {
    return (await env.BUCKET.get(key)) != null;
  }

  describe("POST /api/feeds/:id/unsubscribe", () => {
    it("refuse l'accès sans session (garde)", async () => {
      const res = await SELF.fetch(`${ORIGIN}/api/feeds/x/unsubscribe`, {
        method: "POST",
      });
      expect(res.status).toBe(401);
    });

    it("purge les non-Saved (+ R2), conserve les Saved, masque le feed et le sort du Cron", async () => {
      await seedFeed("f1");
      await seedArticle("a-plain", "f1", {
        contentKey: "articles/a-plain.html",
      });
      await seedArticle("a-saved", "f1", {
        saved: true,
        contentKey: "articles/a-saved.html",
      });

      const res = await SELF.fetch(
        `${ORIGIN}/api/feeds/f1/unsubscribe`,
        authed({ method: "POST" }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: "f1", unsubscribed: true });

      // Non-Saved purgé (D1 + R2) ; Saved conservé (D1 + R2).
      expect(await rowExists("articles", "a-plain")).toBe(false);
      expect(await r2Exists("articles/a-plain.html")).toBe(false);
      expect(await rowExists("articles", "a-saved")).toBe(true);
      expect(await r2Exists("articles/a-saved.html")).toBe(true);

      // Feed conservé mais marqué désabonné et masqué de GET /feeds.
      const feedRow = await env.DB.prepare(
        "SELECT unsubscribed_at FROM feeds WHERE id = ?",
      )
        .bind("f1")
        .first<{ unsubscribed_at: string | null }>();
      expect(feedRow?.unsubscribed_at).toBeTruthy();
      const list = (await (
        await SELF.fetch(`${ORIGIN}/api/feeds`, authed())
      ).json()) as { feeds: { id: string }[] };
      expect(list.feeds.map((f) => f.id)).not.toContain("f1");

      // Sorti de la sélection Cron.
      const due = await getDueFeedIds(getDb(env.DB));
      expect(due).not.toContain("f1");

      // Le désabonnement n'est PAS un Delete (ADR 0018) : le Feed garde sa
      // ligne et « descend » via son updated_at bumpé, sans tombstone Feed.
      expect(await tombstone("feed", "f1")).toBeUndefined();
      expect(typeof (await feedUpdatedAt("f1"))).toBe("number");
      // Ses Articles non-Saved purgés, eux, suivent le chemin de suppression
      // tracé : un tombstone par article purgé.
      expect(typeof (await tombstone("article", "a-plain"))).toBe("number");
      // Le Saved conservé n'a pas de tombstone.
      expect(await tombstone("article", "a-saved")).toBeUndefined();
    });

    it("renvoie 404 sur un feed inconnu", async () => {
      const res = await SELF.fetch(
        `${ORIGIN}/api/feeds/inconnu/unsubscribe`,
        authed({ method: "POST" }),
      );
      expect(res.status).toBe(404);
    });

    it("renvoie 404 si le feed est déjà désabonné", async () => {
      await seedFeed("f-off", { unsubscribedAt: "2026-06-01T00:00:00Z" });
      const res = await SELF.fetch(
        `${ORIGIN}/api/feeds/f-off/unsubscribe`,
        authed({ method: "POST" }),
      );
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/feeds/:id", () => {
    it("refuse l'accès sans session (garde)", async () => {
      const res = await SELF.fetch(`${ORIGIN}/api/feeds/x`, {
        method: "DELETE",
      });
      expect(res.status).toBe(401);
    });

    it("efface le feed, tous ses articles (Saved compris) et leurs objets R2", async () => {
      await seedFeed("f2");
      await seedArticle("d-plain", "f2", {
        contentKey: "articles/d-plain.html",
      });
      await seedArticle("d-saved", "f2", {
        saved: true,
        contentKey: "articles/d-saved.html",
      });

      const res = await SELF.fetch(
        `${ORIGIN}/api/feeds/f2`,
        authed({ method: "DELETE" }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      expect(await rowExists("feeds", "f2")).toBe(false);
      expect(await rowExists("articles", "d-plain")).toBe(false);
      expect(await rowExists("articles", "d-saved")).toBe(false);
      expect(await r2Exists("articles/d-plain.html")).toBe(false);
      expect(await r2Exists("articles/d-saved.html")).toBe(false);

      // Delete destructif (ADR 0018) : tombstone du Feed ET de tous ses Articles
      // (Saved compris), pour que le delta sync (#69) propage la suppression.
      expect(typeof (await tombstone("feed", "f2"))).toBe("number");
      expect(typeof (await tombstone("article", "d-plain"))).toBe("number");
      expect(typeof (await tombstone("article", "d-saved"))).toBe("number");
    });

    it("renvoie 404 sur un feed inconnu", async () => {
      const res = await SELF.fetch(
        `${ORIGIN}/api/feeds/inconnu`,
        authed({ method: "DELETE" }),
      );
      expect(res.status).toBe(404);
    });
  });

  describe("Réabonnement = réactivation (ADR 0010)", () => {
    it("réactive un feed désabonné au lieu de 409 et re-backfille", async () => {
      const url = "https://src.example/react.xml";
      mockOutboundFetch(200, RSS(ITEM(1)));
      const sub = await SELF.fetch(
        `${ORIGIN}/api/feeds`,
        authed({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url }),
        }),
      );
      expect(sub.status).toBe(201);
      const feedId = ((await sub.json()) as { feed: { id: string } }).feed.id;

      await SELF.fetch(
        `${ORIGIN}/api/feeds/${feedId}/unsubscribe`,
        authed({ method: "POST" }),
      );

      // Réabonnement à la même URL : pas de 409, le feed est réactivé.
      mockOutboundFetch(200, RSS(`${ITEM(1)}${ITEM(2)}`));
      const re = await SELF.fetch(
        `${ORIGIN}/api/feeds`,
        authed({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url }),
        }),
      );
      expect(re.status).toBe(201);

      // unsubscribed_at remis à null et feed de nouveau listé.
      const feedRow = await env.DB.prepare(
        "SELECT unsubscribed_at FROM feeds WHERE id = ?",
      )
        .bind(feedId)
        .first<{ unsubscribed_at: string | null }>();
      expect(feedRow?.unsubscribed_at).toBeNull();
      const list = (await (
        await SELF.fetch(`${ORIGIN}/api/feeds`, authed())
      ).json()) as { feeds: { id: string }[] };
      expect(list.feeds.map((f) => f.id)).toContain(feedId);
    });

    it("re-backfille même si le flux a un ETag (etag/last_modified réinitialisés)", async () => {
      const url = "https://src.example/etag.xml";

      // Mock conditionnel : renvoie 304 si la requête porte un If-None-Match,
      // sinon 200 + ETag. Reproduit un serveur respectant le conditional GET.
      function mockConditionalFetch(): void {
        vi.stubGlobal(
          "fetch",
          vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            const headers = new Headers(
              init?.headers as Record<string, string> | undefined,
            );
            if (headers.get("if-none-match")) {
              return new Response(null, { status: 304 });
            }
            return new Response(RSS(`${ITEM(1)}${ITEM(2)}`), {
              status: 200,
              headers: {
                "content-type": "application/rss+xml",
                etag: '"v1"',
              },
            });
          }),
        );
      }

      mockConditionalFetch();
      const sub = await SELF.fetch(
        `${ORIGIN}/api/feeds`,
        authed({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url }),
        }),
      );
      expect(sub.status).toBe(201);
      const feedId = ((await sub.json()) as { feed: { id: string } }).feed.id;

      await SELF.fetch(
        `${ORIGIN}/api/feeds/${feedId}/unsubscribe`,
        authed({ method: "POST" }),
      );

      // Réabonnement : l'ETag d'avant doit être effacé, sinon le GET conditionnel
      // renverrait 304 et ne re-backfillerait rien (articles non-Saved purgés).
      mockConditionalFetch();
      const re = await SELF.fetch(
        `${ORIGIN}/api/feeds`,
        authed({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url }),
        }),
      );
      expect(re.status).toBe(201);
      expect(((await re.json()) as { articleCount: number }).articleCount).toBe(
        2,
      );
      const count = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM articles WHERE feed_id = ?",
      )
        .bind(feedId)
        .first<{ n: number }>();
      expect(count?.n).toBe(2);
    });
  });

  describe("POST /api/feeds/:id/refresh — feed désabonné (#14)", () => {
    it("renvoie 404 et ne ré-ingère pas un feed désabonné", async () => {
      await env.DB.prepare(
        "INSERT INTO feeds (id, url, title, unsubscribed_at) VALUES (?, ?, ?, ?)",
      )
        .bind(
          "f-off",
          "https://src.example/off.xml",
          "Désabonné",
          "2026-06-01T00:00:00Z",
        )
        .run();

      const res = await SELF.fetch(
        `${ORIGIN}/api/feeds/f-off/refresh`,
        authed({ method: "POST" }),
      );
      expect(res.status).toBe(404);
    });
  });
});

describe("updated_at — ingestion (#71, ADR 0018)", () => {
  /** Lit `updated_at` (epoch-ms) du seul article du feed, ou undefined. */
  async function anyArticleUpdatedAt(
    feedId: string,
  ): Promise<number | undefined> {
    const row = await env.DB.prepare(
      "SELECT updated_at FROM articles WHERE feed_id = ? LIMIT 1",
    )
      .bind(feedId)
      .first<{ updated_at: number }>();
    return row?.updated_at;
  }

  it("pose updated_at sur les articles ingérés à l'abonnement", async () => {
    mockOutboundFetch(200, RSS(ITEM(1)));
    const sub = await SELF.fetch(
      `${ORIGIN}/api/feeds`,
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://src.example/ts.xml" }),
      }),
    );
    const feedId = ((await sub.json()) as { feed: { id: string } }).feed.id;
    const ts = await anyArticleUpdatedAt(feedId);
    expect(typeof ts).toBe("number");
    expect(ts).toBeGreaterThan(0);
  });

  it("un refresh sans nouveauté (304) ne bumpe PAS updated_at du Feed (anti-churn delta)", async () => {
    // Les écritures de santé/polling (etag, last_check_at, next_check_at…) ne
    // sont pas des mutations de domaine : elles ne doivent pas faire re-pousser
    // le Feed à chaque poll par le delta sync (#69).
    const url = "https://src.example/poll.xml";
    mockOutboundFetch(200, RSS(ITEM(1)), "application/rss+xml");
    const sub = await SELF.fetch(
      `${ORIGIN}/api/feeds`,
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      }),
    );
    const feedId = ((await sub.json()) as { feed: { id: string } }).feed.id;

    // Fige updated_at à une valeur basse, puis rejoue un poll qui ne ramène rien.
    await env.DB.prepare("UPDATE feeds SET updated_at = 1 WHERE id = ?")
      .bind(feedId)
      .run();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 304 })),
    );
    const refresh = await SELF.fetch(
      `${ORIGIN}/api/feeds/${feedId}/refresh`,
      authed({ method: "POST" }),
    );
    expect(refresh.status).toBe(200);

    // last_check_at/next_check_at ont avancé, mais updated_at reste figé.
    const row = await env.DB.prepare(
      "SELECT updated_at, next_check_at FROM feeds WHERE id = ?",
    )
      .bind(feedId)
      .first<{ updated_at: number; next_check_at: string | null }>();
    expect(row?.updated_at).toBe(1);
    expect(row?.next_check_at).toBeTruthy();
  });
});
