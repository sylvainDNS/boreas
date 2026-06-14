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

/** Insère un Feed avec un `updated_at` (epoch-ms) explicite. */
async function seedFeed(opts: {
  id: string;
  title?: string | null;
  folderId?: string | null;
  unsubscribedAt?: string | null;
  updatedAt: number;
}): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO feeds (id, url, title, folder_id, unsubscribed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      opts.id,
      `https://src.example/${opts.id}.xml`,
      opts.title ?? `Flux ${opts.id}`,
      opts.folderId ?? null,
      opts.unsubscribedAt ?? null,
      opts.updatedAt,
    )
    .run();
}

/** Insère un Folder avec un `updated_at` explicite. */
async function seedFolder(opts: {
  id: string;
  name?: string;
  updatedAt: number;
}): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO folders (id, name, updated_at) VALUES (?, ?, ?)",
  )
    .bind(opts.id, opts.name ?? `Dossier ${opts.id}`, opts.updatedAt)
    .run();
}

/** Insère un Article avec un `updated_at` explicite (le Feed doit exister). */
async function seedArticle(opts: {
  id: string;
  feedId?: string;
  read?: boolean;
  saved?: boolean;
  publishedAt?: string | null;
  fetchedAt?: string;
  updatedAt: number;
}): Promise<void> {
  const feedId = opts.feedId ?? "feed-1";
  await env.DB.prepare(
    "INSERT OR IGNORE INTO feeds (id, url, title, updated_at) VALUES (?, ?, ?, ?)",
  )
    .bind(feedId, `https://src.example/${feedId}.xml`, "Mon flux", 1)
    .run();
  await env.DB.prepare(
    "INSERT INTO articles (id, feed_id, article_key, title, link, read, saved, published_at, fetched_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      opts.id,
      feedId,
      `key-${opts.id}`,
      "Le vent du nord",
      "https://src.example/article",
      opts.read ? 1 : 0,
      opts.saved ? 1 : 0,
      opts.publishedAt ?? null,
      opts.fetchedAt ?? "2026-06-05T12:00:00Z",
      opts.updatedAt,
    )
    .run();
}

/** Insère un tombstone avec un `deleted_at` explicite. */
async function seedTombstone(opts: {
  entityType: "article" | "feed" | "folder";
  entityId: string;
  deletedAt: number;
}): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO tombstones (entity_type, entity_id, deleted_at) VALUES (?, ?, ?)",
  )
    .bind(opts.entityType, opts.entityId, opts.deletedAt)
    .run();
}

interface SyncBody {
  upserts: {
    articles: { id: string }[];
    feeds: { id: string }[];
    folders: { id: string }[];
  };
  tombstones: { entityType: string; entityId: string }[];
  cursor: number | null;
  complete: boolean;
  stale: boolean;
}

async function getSync(
  query = "",
): Promise<{ status: number; body: SyncBody }> {
  const res = await SELF.fetch(`${ORIGIN}/api/sync${query}`, authed());
  return { status: res.status, body: (await res.json()) as SyncBody };
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM tombstones").run();
  await env.DB.prepare("DELETE FROM articles").run();
  await env.DB.prepare("DELETE FROM feeds").run();
  await env.DB.prepare("DELETE FROM folders").run();
});

describe("GET /api/sync — garde", () => {
  it("refuse l'accès sans session", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/sync`);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/sync — sync initiale (since absent)", () => {
  it("renvoie toutes les métadonnées (articles lus + non-lus, feeds, folders)", async () => {
    await seedFolder({ id: "fold-1", updatedAt: 1000 });
    await seedFeed({ id: "feed-1", folderId: "fold-1", updatedAt: 1000 });
    await seedArticle({ id: "art-read", read: true, updatedAt: 2000 });
    await seedArticle({ id: "art-unread", read: false, updatedAt: 2000 });

    const { status, body } = await getSync();
    expect(status).toBe(200);
    expect(body.stale).toBe(false);
    expect(body.upserts.articles.map((a) => a.id).sort()).toEqual([
      "art-read",
      "art-unread",
    ]);
    expect(body.upserts.feeds.map((f) => f.id)).toEqual(["feed-1"]);
    expect(body.upserts.folders.map((f) => f.id)).toEqual(["fold-1"]);
  });

  it("renvoie l'item article au format wire de la liste (avec feedName, saved, read)", async () => {
    await seedArticle({ id: "art-1", read: false, saved: true, updatedAt: 5 });
    const { body } = await getSync();
    const art = body.upserts.articles[0] as Record<string, unknown>;
    expect(art).toMatchObject({
      id: "art-1",
      feedId: "feed-1",
      feedName: "Mon flux",
      read: false,
      saved: true,
    });
    // Le contenu HTML ne transite pas par /api/sync (#75).
    expect(art).not.toHaveProperty("content");
    // updated_at ne fuit pas dans le wire.
    expect(art).not.toHaveProperty("updatedAt");
    expect(art).not.toHaveProperty("updated_at");
  });

  it("inclut les feeds désabonnés et leurs articles (réplica complet)", async () => {
    await seedFeed({
      id: "feed-off",
      unsubscribedAt: "2026-06-01T00:00:00Z",
      updatedAt: 100,
    });
    await seedArticle({ id: "art-off", feedId: "feed-off", updatedAt: 100 });

    const { body } = await getSync();
    expect(body.upserts.feeds.map((f) => f.id)).toContain("feed-off");
    expect(body.upserts.articles.map((a) => a.id)).toContain("art-off");
    // Le feed désabonné porte le marqueur `unsubscribed` (absent de GET /api/feeds).
    const off = body.upserts.feeds.find((f) => f.id === "feed-off") as {
      unsubscribed?: boolean;
    };
    expect(off.unsubscribed).toBe(true);
  });

  it("pose un curseur = borne haute des updated_at servis, et complete=true", async () => {
    await seedArticle({ id: "art-a", updatedAt: 10 });
    await seedArticle({ id: "art-b", updatedAt: 42 });
    const { body } = await getSync();
    expect(body.complete).toBe(true);
    expect(body.cursor).toBe(42);
  });
});

describe("GET /api/sync — pagination keyset de la sync initiale", () => {
  it("pagine les articles sans trou ni doublon et avance le curseur", async () => {
    // 70 articles à updated_at strictement croissants (> 2 pages de 30).
    // Timestamps réalistes (récents) pour ne pas trébucher sur le curseur périmé.
    const base = Date.now() - 10_000;
    const ids: string[] = [];
    for (let i = 0; i < 70; i++) {
      const id = `art-${String(i).padStart(2, "0")}`;
      ids.push(id);
      await seedArticle({ id, updatedAt: base + i });
    }

    const seen: string[] = [];
    let cursor: number | null = null;
    let complete = false;
    let guard = 0;
    do {
      const q: string = cursor === null ? "" : `?since=${cursor}`;
      const { body } = await getSync(q);
      for (const a of body.upserts.articles) seen.push(a.id);
      cursor = body.cursor;
      complete = body.complete;
      if (++guard > 10) throw new Error("pagination ne termine pas");
    } while (!complete);

    // Toutes les pages sauf la dernière sont pleines : au moins 3 itérations.
    expect(guard).toBeGreaterThanOrEqual(3);
    expect(new Set(seen).size).toBe(70);
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  it("ne coupe pas un même updated_at entre deux pages (curseur sur frontière propre)", async () => {
    // 40 articles partageant le même updated_at (ex. backfill d'un lot) : la
    // première page doit tous les servir plutôt que de figer le curseur.
    for (let i = 0; i < 40; i++) {
      await seedArticle({
        id: `art-${String(i).padStart(2, "0")}`,
        updatedAt: 7,
      });
    }
    const { body } = await getSync();
    // Aucun curseur ne pouvant progresser au-delà de 7 sans tout servir : la page
    // contient les 40 articles et se déclare complète.
    expect(body.upserts.articles).toHaveLength(40);
    expect(body.complete).toBe(true);
    expect(body.cursor).toBe(7);
  });
});

describe("GET /api/sync — sync incrémentale (since fourni)", () => {
  // Timestamps réalistes (epoch-ms récents) : un `since` synthétique ancien serait
  // (à raison) signalé périmé, ce qui relève d'un autre cas de test.
  const T0 = Date.now() - 10_000;

  it("ne renvoie que les upserts dont updated_at > since", async () => {
    await seedArticle({ id: "art-old", updatedAt: T0 });
    await seedArticle({ id: "art-new", updatedAt: T0 + 100 });
    await seedFeed({ id: "feed-old", updatedAt: T0 });
    await seedFeed({ id: "feed-new", updatedAt: T0 + 100 });
    await seedFolder({ id: "fold-old", updatedAt: T0 });
    await seedFolder({ id: "fold-new", updatedAt: T0 + 100 });

    const { body } = await getSync(`?since=${T0 + 50}`);
    expect(body.upserts.articles.map((a) => a.id)).toEqual(["art-new"]);
    expect(body.upserts.feeds.map((f) => f.id)).toEqual(["feed-new"]);
    expect(body.upserts.folders.map((f) => f.id)).toEqual(["fold-new"]);
  });

  it("renvoie les tombstones dont deleted_at > since", async () => {
    await seedTombstone({
      entityType: "article",
      entityId: "art-gone",
      deletedAt: T0 + 100,
    });
    await seedTombstone({
      entityType: "feed",
      entityId: "feed-gone",
      deletedAt: T0,
    });

    const { body } = await getSync(`?since=${T0 + 50}`);
    expect(body.tombstones).toEqual([
      { entityType: "article", entityId: "art-gone" },
    ]);
  });

  it("le curseur couvre aussi les deleted_at des tombstones", async () => {
    await seedArticle({ id: "art-1", updatedAt: T0 + 100 });
    await seedTombstone({
      entityType: "article",
      entityId: "art-gone",
      deletedAt: T0 + 200,
    });
    const { body } = await getSync(`?since=${T0 + 50}`);
    expect(body.complete).toBe(true);
    expect(body.cursor).toBe(T0 + 200);
  });

  it("renvoie une page vide complète (cursor null) quand rien n'a changé", async () => {
    await seedArticle({ id: "art-1", updatedAt: T0 });
    const { body } = await getSync(`?since=${T0 + 5000}`);
    expect(body.upserts.articles).toEqual([]);
    expect(body.tombstones).toEqual([]);
    expect(body.complete).toBe(true);
    expect(body.cursor).toBeNull();
    expect(body.stale).toBe(false);
  });
});

describe("GET /api/sync — curseur périmé", () => {
  it("signale stale quand since est antérieur à la fenêtre de rétention des tombstones", async () => {
    // `since` très ancien (epoch-ms = 1) : antérieur à toute fenêtre raisonnable.
    const { body } = await getSync("?since=1");
    expect(body.stale).toBe(true);
    expect(body.upserts.articles).toEqual([]);
    expect(body.upserts.feeds).toEqual([]);
    expect(body.upserts.folders).toEqual([]);
    expect(body.tombstones).toEqual([]);
  });

  it("since=0 n'est PAS périmé (sync initiale complète assumée)", async () => {
    await seedArticle({ id: "art-1", updatedAt: 100 });
    const { body } = await getSync("?since=0");
    expect(body.stale).toBe(false);
    expect(body.upserts.articles.map((a) => a.id)).toEqual(["art-1"]);
  });

  it("un since récent (dans la fenêtre) n'est pas périmé", async () => {
    const recent = Date.now() - 60_000; // il y a une minute
    const { body } = await getSync(`?since=${recent}`);
    expect(body.stale).toBe(false);
  });
});
