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

/**
 * Insère un Folder (id explicite pour des assertions déterministes). `rank` est
 * une clé fractional-indexing explicite (ADR 0020) : à défaut, on dérive un rang
 * croissant de l'id pour éviter les collisions entre Folders seedés.
 */
async function seedFolder(
  id: string,
  name: string,
  rank?: string,
): Promise<void> {
  await env.DB.prepare("INSERT INTO folders (id, name, rank) VALUES (?, ?, ?)")
    .bind(id, name, rank ?? `a${id}`)
    .run();
}

/** Insère un Feed, éventuellement rattaché à un Folder. */
async function seedFeed(
  id: string,
  opts: { title?: string; folderId?: string | null } = {},
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO feeds (id, url, title, folder_id) VALUES (?, ?, ?, ?)",
  )
    .bind(
      id,
      `https://src.example/${id}.xml`,
      opts.title ?? `Flux ${id}`,
      opts.folderId ?? null,
    )
    .run();
}

/** Insère un Article non-lu (sauf `read: true`) rattaché à un Feed. */
async function seedArticle(
  id: string,
  feedId: string,
  opts: { read?: boolean } = {},
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO articles (id, feed_id, article_key, title, read) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, feedId, `key-${id}`, `Article ${id}`, opts.read ? 1 : 0)
    .run();
}

async function folderIdOfFeed(feedId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT folder_id AS f FROM feeds WHERE id = ?",
  )
    .bind(feedId)
    .first<{ f: string | null }>();
  return row?.f ?? null;
}

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

beforeEach(async () => {
  // Isolation : articles → feeds → folders (ordre dicté par les FK).
  await env.DB.prepare("DELETE FROM tombstones").run();
  await env.DB.prepare("DELETE FROM articles").run();
  await env.DB.prepare("DELETE FROM feeds").run();
  await env.DB.prepare("DELETE FROM folders").run();
});

describe("CRUD /api/folders (#13)", () => {
  it("refuse l'accès sans session (garde)", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/folders`);
    expect(res.status).toBe(401);
  });

  it("crée des Folders et les liste, triés par rang (ordre de création, ADR 0020)", async () => {
    await SELF.fetch(
      `${ORIGIN}/api/folders`,
      authed({ method: "POST", body: JSON.stringify({ name: "  Tech  " }) }),
    );
    await SELF.fetch(
      `${ORIGIN}/api/folders`,
      authed({ method: "POST", body: JSON.stringify({ name: "Actu" }) }),
    );

    const res = await SELF.fetch(`${ORIGIN}/api/folders`, authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      folders: { name: string; rank: string }[];
    };
    // Tri par rang : chaque création place le Folder en fin de liste (rang
    // croissant), donc l'ordre suit l'ordre de création. Trim appliqué au nom.
    expect(body.folders.map((f) => f.name)).toEqual(["Tech", "Actu"]);
    // Les rangs exposés sont strictement croissants.
    expect(body.folders[0].rank < body.folders[1].rank).toBe(true);
  });

  it("expose le rang dans la réponse de création (POST, ADR 0020)", async () => {
    const res = await SELF.fetch(
      `${ORIGIN}/api/folders`,
      authed({ method: "POST", body: JSON.stringify({ name: "Tech" }) }),
    );
    expect(res.status).toBe(201);
    const { folder } = (await res.json()) as {
      folder: { id: string; name: string; rank: string };
    };
    expect(typeof folder.rank).toBe("string");
    expect(folder.rank.length).toBeGreaterThan(0);
  });

  it("refuse un nom vide (400)", async () => {
    const res = await SELF.fetch(
      `${ORIGIN}/api/folders`,
      authed({ method: "POST", body: JSON.stringify({ name: "   " }) }),
    );
    expect(res.status).toBe(400);
  });

  it("renomme un Folder (200) et 404 sur id inconnu", async () => {
    await seedFolder("fold-1", "Ancien", "a0");

    const ok = await SELF.fetch(
      `${ORIGIN}/api/folders/fold-1`,
      authed({ method: "PATCH", body: JSON.stringify({ name: "Nouveau" }) }),
    );
    expect(ok.status).toBe(200);
    // Le renommage préserve le rang et le ré-écho (ADR 0020).
    expect(await ok.json()).toEqual({
      id: "fold-1",
      name: "Nouveau",
      rank: "a0",
    });

    const missing = await SELF.fetch(
      `${ORIGIN}/api/folders/nope`,
      authed({ method: "PATCH", body: JSON.stringify({ name: "X" }) }),
    );
    expect(missing.status).toBe(404);
  });

  it("réordonne un Folder via PATCH {rank} : écrit le rang verbatim et ré-écho (ADR 0020)", async () => {
    await seedFolder("a", "Alpha", "a0");
    await seedFolder("b", "Bravo", "a1");
    await seedFolder("c", "Charlie", "a2");

    // Déplace "a" entre "b" et "a2" : le client a calculé un rang intercalé.
    const res = await SELF.fetch(
      `${ORIGIN}/api/folders/a`,
      authed({ method: "PATCH", body: JSON.stringify({ rank: "a1V" }) }),
    );
    expect(res.status).toBe(200);
    // Écho = folderSchema complet relu {id, name, rank}, rang écrit verbatim.
    expect(await res.json()).toEqual({ id: "a", name: "Alpha", rank: "a1V" });

    // La liste se re-trie par rang : Bravo, Alpha, Charlie.
    const list = await SELF.fetch(`${ORIGIN}/api/folders`, authed());
    const body = (await list.json()) as { folders: { name: string }[] };
    expect(body.folders.map((f) => f.name)).toEqual([
      "Bravo",
      "Alpha",
      "Charlie",
    ]);
  });

  it("PATCH {rank} bumpe updated_at et ne réécrit qu'une seule ligne", async () => {
    await seedFolder("a", "Alpha", "a0");
    await seedFolder("b", "Bravo", "a1");
    // Force des updated_at bas pour observer le bump sélectif.
    await env.DB.prepare("UPDATE folders SET updated_at = 1").run();

    await SELF.fetch(
      `${ORIGIN}/api/folders/a`,
      authed({ method: "PATCH", body: JSON.stringify({ rank: "a2" }) }),
    );

    const rows = await env.DB.prepare(
      "SELECT id, rank, updated_at FROM folders ORDER BY id",
    ).all<{ id: string; rank: string; updated_at: number }>();
    const byId = new Map(rows.results.map((r) => [r.id, r]));
    // Seule la ligne déplacée est réécrite (rang + updated_at).
    expect(byId.get("a")?.rank).toBe("a2");
    expect(byId.get("a")?.updated_at).toBeGreaterThan(1);
    expect(byId.get("b")?.rank).toBe("a1");
    expect(byId.get("b")?.updated_at).toBe(1);
  });

  it("PATCH {name} seul n'altère pas le rang", async () => {
    await seedFolder("a", "Alpha", "a5");
    const res = await SELF.fetch(
      `${ORIGIN}/api/folders/a`,
      authed({ method: "PATCH", body: JSON.stringify({ name: "Renommé" }) }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "a", name: "Renommé", rank: "a5" });
  });

  it("PATCH {} (aucun champ) → 400", async () => {
    await seedFolder("a", "Alpha", "a0");
    const res = await SELF.fetch(
      `${ORIGIN}/api/folders/a`,
      authed({ method: "PATCH", body: JSON.stringify({}) }),
    );
    expect(res.status).toBe(400);
  });

  it("PATCH {rank} sur un id inconnu → 404", async () => {
    const res = await SELF.fetch(
      `${ORIGIN}/api/folders/nope`,
      authed({ method: "PATCH", body: JSON.stringify({ rank: "a0" }) }),
    );
    expect(res.status).toBe(404);
  });

  it("supprime un Folder en désassignant ses Feeds (pas de désabonnement)", async () => {
    await seedFolder("fold-1", "Tech");
    await seedFeed("feed-1", { folderId: "fold-1" });

    const res = await SELF.fetch(
      `${ORIGIN}/api/folders/fold-1`,
      authed({ method: "DELETE" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // Le Folder est parti, le Feed subsiste mais « sans dossier ».
    const folders = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM folders",
    ).first<{ n: number }>();
    expect(folders?.n).toBe(0);
    expect(await folderIdOfFeed("feed-1")).toBeNull();

    // Delete destructif (ADR 0018) : tombstone du Folder pour le delta sync (#69).
    // Le Feed désassigné, lui, n'est pas tombstoné (il « descend » via updated_at).
    expect(typeof (await tombstone("folder", "fold-1"))).toBe("number");
    expect(await tombstone("feed", "feed-1")).toBeUndefined();

    const missing = await SELF.fetch(
      `${ORIGIN}/api/folders/fold-1`,
      authed({ method: "DELETE" }),
    );
    expect(missing.status).toBe(404);
  });
});

describe("PATCH /api/feeds/:id — renommer & déplacer (US 12, #13)", () => {
  it("renomme un Feed", async () => {
    await seedFeed("feed-1", { title: "Avant" });

    const res = await SELF.fetch(
      `${ORIGIN}/api/feeds/feed-1`,
      authed({ method: "PATCH", body: JSON.stringify({ title: "Après" }) }),
    );
    expect(res.status).toBe(200);
    const title = await env.DB.prepare(
      "SELECT title AS t FROM feeds WHERE id = ?",
    )
      .bind("feed-1")
      .first<{ t: string }>();
    expect(title?.t).toBe("Après");
  });

  it("déplace un Feed vers un Folder puis le désassigne (null)", async () => {
    await seedFolder("fold-1", "Tech");
    await seedFeed("feed-1");

    const move = await SELF.fetch(
      `${ORIGIN}/api/feeds/feed-1`,
      authed({ method: "PATCH", body: JSON.stringify({ folderId: "fold-1" }) }),
    );
    expect(move.status).toBe(200);
    expect(await folderIdOfFeed("feed-1")).toBe("fold-1");

    const unassign = await SELF.fetch(
      `${ORIGIN}/api/feeds/feed-1`,
      authed({ method: "PATCH", body: JSON.stringify({ folderId: null }) }),
    );
    expect(unassign.status).toBe(200);
    expect(await folderIdOfFeed("feed-1")).toBeNull();
  });

  it("rejette un Folder cible inconnu (422) et un Feed inconnu (404)", async () => {
    await seedFeed("feed-1");

    const badFolder = await SELF.fetch(
      `${ORIGIN}/api/feeds/feed-1`,
      authed({ method: "PATCH", body: JSON.stringify({ folderId: "ghost" }) }),
    );
    expect(badFolder.status).toBe(422);
    expect(await badFolder.json()).toEqual({ error: "folder_not_found" });

    await seedFolder("fold-1", "Tech");
    const badFeed = await SELF.fetch(
      `${ORIGIN}/api/feeds/ghost`,
      authed({ method: "PATCH", body: JSON.stringify({ folderId: "fold-1" }) }),
    );
    expect(badFeed.status).toBe(404);
  });

  it("refuse un corps sans champ modifiable (400)", async () => {
    await seedFeed("feed-1");
    const res = await SELF.fetch(
      `${ORIGIN}/api/feeds/feed-1`,
      authed({ method: "PATCH", body: JSON.stringify({}) }),
    );
    expect(res.status).toBe(400);
  });
});

describe("Vue & compteurs par Folder (#13)", () => {
  beforeEach(async () => {
    // Folder « Tech » = 2 feeds ; un feed hors dossier. Non-lus : feed-1 → 2,
    // feed-2 → 1 (Tech = 3) ; feed-3 (hors dossier) → 1.
    await seedFolder("fold-1", "Tech");
    await seedFeed("feed-1", { folderId: "fold-1" });
    await seedFeed("feed-2", { folderId: "fold-1" });
    await seedFeed("feed-3");
    await seedArticle("a1", "feed-1");
    await seedArticle("a2", "feed-1");
    await seedArticle("a3", "feed-2");
    await seedArticle("a4", "feed-3");
  });

  it("GET /articles?folderId agrège les articles de tous ses Feeds", async () => {
    const res = await SELF.fetch(
      `${ORIGIN}/api/articles?filter=all&folderId=fold-1`,
      authed(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { articles: { feedId: string }[] };
    // 3 articles (feed-1 ×2, feed-2 ×1) ; pas feed-3 (hors dossier).
    expect(body.articles).toHaveLength(3);
    expect(new Set(body.articles.map((a) => a.feedId))).toEqual(
      new Set(["feed-1", "feed-2"]),
    );
  });

  it("GET /counts expose byFolder exact (non classés exclus)", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/articles/counts`, authed());
    const body = (await res.json()) as {
      total: number;
      byFolder: { folderId: string; count: number }[];
    };
    expect(body.total).toBe(4);
    expect(body.byFolder).toEqual([{ folderId: "fold-1", count: 3 }]);
  });

  it("POST /mark-read scope folder ne marque que les Feeds du Folder", async () => {
    const res = await SELF.fetch(
      `${ORIGIN}/api/articles/mark-read`,
      authed({
        method: "POST",
        body: JSON.stringify({ scope: "folder", folderId: "fold-1" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 3 });

    // feed-3 (hors dossier) reste non-lu.
    const unread = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM articles WHERE read = 0",
    ).first<{ n: number }>();
    expect(unread?.n).toBe(1);
  });
});

describe("updated_at — bump des mutations Feed/Folder (#71, ADR 0018)", () => {
  /** Lit `updated_at` (epoch-ms) d'une ligne d'une table donnée. */
  async function updatedAtOf(
    table: "feeds" | "folders",
    id: string,
  ): Promise<number | undefined> {
    const row = await env.DB.prepare(
      `SELECT updated_at FROM ${table} WHERE id = ?`,
    )
      .bind(id)
      .first<{ updated_at: number }>();
    return row?.updated_at;
  }

  /** Force `updated_at` à une valeur basse pour observer un bump ultérieur. */
  async function setUpdatedAt(
    table: "feeds" | "folders",
    id: string,
    value: number,
  ): Promise<void> {
    await env.DB.prepare(`UPDATE ${table} SET updated_at = ? WHERE id = ?`)
      .bind(value, id)
      .run();
  }

  it("création d'un Folder pose updated_at", async () => {
    const res = await SELF.fetch(
      `${ORIGIN}/api/folders`,
      authed({ method: "POST", body: JSON.stringify({ name: "Tech" }) }),
    );
    const { folder } = (await res.json()) as { folder: { id: string } };
    expect(typeof (await updatedAtOf("folders", folder.id))).toBe("number");
  });

  it("renommage d'un Folder bumpe updated_at", async () => {
    await seedFolder("fold-1", "Ancien");
    await setUpdatedAt("folders", "fold-1", 1);

    await SELF.fetch(
      `${ORIGIN}/api/folders/fold-1`,
      authed({ method: "PATCH", body: JSON.stringify({ name: "Nouveau" }) }),
    );

    expect(await updatedAtOf("folders", "fold-1")).toBeGreaterThan(1);
  });

  it("renommage et déplacement d'un Feed bumpent updated_at", async () => {
    await seedFolder("fold-1", "Tech");
    await seedFeed("feed-1", { title: "Avant" });
    await setUpdatedAt("feeds", "feed-1", 1);

    await SELF.fetch(
      `${ORIGIN}/api/feeds/feed-1`,
      authed({ method: "PATCH", body: JSON.stringify({ title: "Après" }) }),
    );
    expect(await updatedAtOf("feeds", "feed-1")).toBeGreaterThan(1);

    await setUpdatedAt("feeds", "feed-1", 1);
    await SELF.fetch(
      `${ORIGIN}/api/feeds/feed-1`,
      authed({ method: "PATCH", body: JSON.stringify({ folderId: "fold-1" }) }),
    );
    expect(await updatedAtOf("feeds", "feed-1")).toBeGreaterThan(1);
  });

  it("suppression d'un Folder désassigne ses Feeds en bumpant leur updated_at", async () => {
    await seedFolder("fold-1", "Tech");
    await seedFeed("feed-1", { folderId: "fold-1" });
    await setUpdatedAt("feeds", "feed-1", 1);

    await SELF.fetch(
      `${ORIGIN}/api/folders/fold-1`,
      authed({ method: "DELETE" }),
    );

    // Le Feed désassigné « descend » via son updated_at bumpé (pas de tombstone).
    expect(await updatedAtOf("feeds", "feed-1")).toBeGreaterThan(1);
  });
});

describe("Contrat wire inchangé — updated_at non exposé (#71, AC#4)", () => {
  it("GET /api/feeds n'expose pas updated_at", async () => {
    await seedFeed("feed-1");
    const body = (await (
      await SELF.fetch(`${ORIGIN}/api/feeds`, authed())
    ).json()) as { feeds: Record<string, unknown>[] };
    expect(body.feeds[0]).not.toHaveProperty("updated_at");
    expect(body.feeds[0]).not.toHaveProperty("updatedAt");
  });

  it("GET /api/folders n'expose pas updated_at", async () => {
    await seedFolder("fold-1", "Tech");
    const body = (await (
      await SELF.fetch(`${ORIGIN}/api/folders`, authed())
    ).json()) as { folders: Record<string, unknown>[] };
    expect(body.folders[0]).not.toHaveProperty("updated_at");
    expect(body.folders[0]).not.toHaveProperty("updatedAt");
  });
});
