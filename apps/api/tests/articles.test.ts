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

/** Lit `updated_at` (epoch-ms) d'un Article. */
async function updatedAt(id: string): Promise<number | undefined> {
  const row = await env.DB.prepare(
    "SELECT updated_at FROM articles WHERE id = ?",
  )
    .bind(id)
    .first<{ updated_at: number }>();
  return row?.updated_at;
}

/** Force `updated_at` d'un Article à une valeur basse, pour observer un bump. */
async function setUpdatedAt(id: string, value: number): Promise<void> {
  await env.DB.prepare("UPDATE articles SET updated_at = ? WHERE id = ?")
    .bind(value, id)
    .run();
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM tombstones").run();
  await env.DB.prepare("DELETE FROM articles").run();
  await env.DB.prepare("DELETE FROM feeds").run();
});

describe("GET /api/articles/:id — lecteur", () => {
  it("refuse l'accès sans session (garde)", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/articles/art-1`);
    expect(res.status).toBe(401);
  });

  it("sert le contenu stocké en R2 SANS marquer l'Article Read (#75)", async () => {
    const key = "articles/art-1.html";
    await env.BUCKET.put(key, "<p>Le vent du nord souffle.</p>");
    await seedArticle({ id: "art-1", contentKey: key });

    const res = await SELF.fetch(`${ORIGIN}/api/articles/art-1`, authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      feedId: string;
      feedName: string;
      title: string;
      link: string;
      content: string | null;
    };
    expect(body.id).toBe("art-1");
    expect(body.feedId).toBe("feed-1");
    expect(body.feedName).toBe("Mon flux");
    expect(body.content).toBe("<p>Le vent du nord souffle.</p>");

    // #75 : le GET ne marque PLUS Read (le Read passe côté client à l'ouverture).
    const row = await env.DB.prepare("SELECT read FROM articles WHERE id = ?")
      .bind("art-1")
      .first<{ read: number }>();
    expect(row?.read).toBe(0);
  });

  it("renvoie saved + unread (état Read courant, le GET ne marque plus Read #75)", async () => {
    await seedArticle({
      id: "art-su",
      contentKey: null,
      read: false,
      saved: true,
    });

    const res = await SELF.fetch(`${ORIGIN}/api/articles/art-su`, authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { saved: boolean; unread: boolean };
    // `unread` reflète l'état Read courant : l'article reste non-lu après le GET.
    expect(body).toMatchObject({ saved: true, unread: true });
    expect(await readState("art-su")).toBe(0);
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

  it("laisse Read inchangé en ouvrant un article déjà lu (#75)", async () => {
    await seedArticle({ id: "art-4", contentKey: null, read: true });

    const res = await SELF.fetch(`${ORIGIN}/api/articles/art-4`, authed());
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT read FROM articles WHERE id = ?")
      .bind("art-4")
      .first<{ read: number }>();
    expect(row?.read).toBe(1);
  });

  it("ouvrir N non-lus via GET /:id ne les passe pas en Read (#75, AC#2)", async () => {
    await seedArticle({ id: "art-n1", read: false });
    await seedArticle({ id: "art-n2", read: false });

    await SELF.fetch(`${ORIGIN}/api/articles/art-n1`, authed());
    await SELF.fetch(`${ORIGIN}/api/articles/art-n2`, authed());

    expect(await readState("art-n1")).toBe(0);
    expect(await readState("art-n2")).toBe(0);
  });

  it("renvoie 404 pour un article inconnu", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/articles/inexistant`, authed());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});

describe("POST /api/articles/content — batch HTML hors-ligne (#75)", () => {
  it("refuse l'accès sans session (garde)", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/articles/content`, {
      method: "POST",
      body: JSON.stringify({ ids: ["art-1"] }),
    });
    expect(res.status).toBe(401);
  });

  it("renvoie le HTML R2 des ids demandés, SANS marquer Read (#75)", async () => {
    await env.BUCKET.put("articles/art-1.html", "<p>Un</p>");
    await env.BUCKET.put("articles/art-2.html", "<p>Deux</p>");
    await seedArticle({
      id: "art-1",
      contentKey: "articles/art-1.html",
      read: false,
    });
    await seedArticle({
      id: "art-2",
      contentKey: "articles/art-2.html",
      read: false,
    });

    const res = await SELF.fetch(
      `${ORIGIN}/api/articles/content`,
      authed({
        method: "POST",
        body: JSON.stringify({ ids: ["art-1", "art-2"] }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; html: string | null }[];
    const byId = Object.fromEntries(body.map((r) => [r.id, r.html]));
    expect(byId).toEqual({
      "art-1": "<p>Un</p>",
      "art-2": "<p>Deux</p>",
    });
    // Garantie clé : aucun des articles n'est passé Read par le batch.
    expect(await readState("art-1")).toBe(0);
    expect(await readState("art-2")).toBe(0);
  });

  it("renvoie html:null quand l'article n'a pas de content_key", async () => {
    await seedArticle({ id: "art-1", contentKey: null });

    const res = await SELF.fetch(
      `${ORIGIN}/api/articles/content`,
      authed({ method: "POST", body: JSON.stringify({ ids: ["art-1"] }) }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: "art-1", html: null }]);
  });

  it("dégrade en html:null si l'objet R2 est absent (sans 500)", async () => {
    // Clé jamais écrite en R2 (buckets miniflare persistants entre cas du fichier).
    await seedArticle({
      id: "art-1",
      contentKey: "articles/art-1-missing.html",
    });

    const res = await SELF.fetch(
      `${ORIGIN}/api/articles/content`,
      authed({ method: "POST", body: JSON.stringify({ ids: ["art-1"] }) }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: "art-1", html: null }]);
  });

  it("ignore les ids inconnus (absents de la réponse)", async () => {
    await env.BUCKET.put("articles/art-1.html", "<p>Un</p>");
    await seedArticle({ id: "art-1", contentKey: "articles/art-1.html" });

    const res = await SELF.fetch(
      `${ORIGIN}/api/articles/content`,
      authed({
        method: "POST",
        body: JSON.stringify({ ids: ["art-1", "inconnu"] }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string }[];
    expect(body.map((r) => r.id)).toEqual(["art-1"]);
  });

  it("renvoie un tableau vide pour une liste d'ids vide", async () => {
    const res = await SELF.fetch(
      `${ORIGIN}/api/articles/content`,
      authed({ method: "POST", body: JSON.stringify({ ids: [] }) }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("renvoie 400 sur un corps invalide", async () => {
    const res = await SELF.fetch(
      `${ORIGIN}/api/articles/content`,
      authed({ method: "POST", body: JSON.stringify({ ids: "art-1" }) }),
    );
    expect(res.status).toBe(400);
  });

  it("n'est pas capturé par la route /:id (POST vs GET, et chemin distinct)", async () => {
    // `content` ne doit pas être interprété comme un id d'article.
    const res = await SELF.fetch(
      `${ORIGIN}/api/articles/content`,
      authed({ method: "POST", body: JSON.stringify({ ids: [] }) }),
    );
    expect(res.status).toBe(200);
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

describe("updated_at — bump des mutations de domaine (#71, ADR 0018)", () => {
  it("PATCH read/saved bumpe updated_at", async () => {
    await seedArticle({ id: "art-1", read: false });
    await setUpdatedAt("art-1", 1);

    await SELF.fetch(
      `${ORIGIN}/api/articles/art-1`,
      authed({ method: "PATCH", body: JSON.stringify({ read: true }) }),
    );

    const after = await updatedAt("art-1");
    expect(typeof after).toBe("number");
    expect(after).toBeGreaterThan(1);
  });

  it("l'ouverture (GET /:id) ne marque plus Read → updated_at inchangé (#75)", async () => {
    await seedArticle({ id: "art-1", read: false });
    await setUpdatedAt("art-1", 42);

    await SELF.fetch(`${ORIGIN}/api/articles/art-1`, authed());

    // #75 : le GET n'écrit rien (le Read passe côté client) → pas de bump.
    expect(await updatedAt("art-1")).toBe(42);
  });

  it("mark-read bumpe updated_at des seuls articles basculés", async () => {
    await seedArticle({ id: "art-u", read: false });
    await seedArticle({ id: "art-r", read: true });
    await setUpdatedAt("art-u", 1);
    await setUpdatedAt("art-r", 1);

    await SELF.fetch(
      `${ORIGIN}/api/articles/mark-read`,
      authed({ method: "POST", body: JSON.stringify({ scope: "global" }) }),
    );

    // Le non-lu basculé est bumpé ; le déjà-lu (non touché) ne l'est pas.
    expect(await updatedAt("art-u")).toBeGreaterThan(1);
    expect(await updatedAt("art-r")).toBe(1);
  });
});

describe("Contrat wire inchangé — updated_at non exposé (#71, AC#4)", () => {
  it("GET /api/articles n'expose pas updated_at", async () => {
    await seedArticle({ id: "art-1", read: false });
    const body = (await (
      await SELF.fetch(`${ORIGIN}/api/articles?filter=all`, authed())
    ).json()) as { articles: Record<string, unknown>[] };
    expect(body.articles[0]).not.toHaveProperty("updated_at");
    expect(body.articles[0]).not.toHaveProperty("updatedAt");
  });

  it("GET /api/articles/:id n'expose pas updated_at", async () => {
    await seedArticle({ id: "art-1", read: false });
    const body = (await (
      await SELF.fetch(`${ORIGIN}/api/articles/art-1`, authed())
    ).json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("updated_at");
    expect(body).not.toHaveProperty("updatedAt");
  });
});
