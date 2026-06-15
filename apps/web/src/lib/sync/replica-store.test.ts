import "fake-indexeddb/auto";
import type { SyncArticle, SyncFeed, SyncFolder } from "@boreas/api-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enqueueOutbox } from "./outbox-store";
import {
  applyDelta,
  deleteReplica,
  garbageCollectContent,
  missingContentIds,
  openReplica,
  type ReplicaDb,
  readArticleContent,
  readSyncCursor,
  writeArticleContent,
  writeSyncCursor,
} from "./replica-store";

function article(over: Partial<SyncArticle> & { id: string }): SyncArticle {
  return {
    id: over.id,
    feedId: over.feedId ?? "feed-1",
    feedName: over.feedName ?? "Mon flux",
    title: over.title ?? `Titre ${over.id}`,
    summary: over.summary ?? null,
    link: over.link ?? null,
    publishedAt: over.publishedAt ?? null,
    fetchedAt: over.fetchedAt ?? "2026-06-05T12:00:00Z",
    read: over.read ?? false,
    saved: over.saved ?? false,
  };
}

function feed(over: Partial<SyncFeed> & { id: string }): SyncFeed {
  return {
    id: over.id,
    url: over.url ?? `https://src.example/${over.id}.xml`,
    title: over.title ?? `Flux ${over.id}`,
    status: over.status ?? "ok",
    lastError: over.lastError ?? null,
    lastCheckAt: over.lastCheckAt ?? null,
    folderId: over.folderId ?? null,
    unsubscribed: over.unsubscribed ?? false,
  };
}

function folder(over: Partial<SyncFolder> & { id: string }): SyncFolder {
  return { id: over.id, name: over.name ?? `Dossier ${over.id}` };
}

let db: ReplicaDb;

beforeEach(async () => {
  await deleteReplica();
  db = await openReplica();
});

afterEach(() => {
  db.close();
});

describe("replica-store — ouverture & curseur", () => {
  it("démarre sans curseur (sync initiale à faire)", async () => {
    expect(await readSyncCursor(db)).toBeNull();
  });

  it("persiste et relit le curseur de sync", async () => {
    await writeSyncCursor(db, 4242);
    expect(await readSyncCursor(db)).toBe(4242);
  });
});

describe("replica-store — applyDelta (upserts)", () => {
  it("insère articles, feeds et folders", async () => {
    await applyDelta(db, {
      upserts: {
        articles: [article({ id: "a1" })],
        feeds: [feed({ id: "feed-1" })],
        folders: [folder({ id: "fold-1" })],
      },
      tombstones: [],
    });

    expect(await db.get("articles", "a1")).toMatchObject({ id: "a1" });
    expect(await db.get("feeds", "feed-1")).toMatchObject({ id: "feed-1" });
    expect(await db.get("folders", "fold-1")).toMatchObject({ id: "fold-1" });
  });

  it("met à jour (upsert) un article existant par id", async () => {
    await applyDelta(db, {
      upserts: {
        articles: [article({ id: "a1", read: false })],
        feeds: [],
        folders: [],
      },
      tombstones: [],
    });
    await applyDelta(db, {
      upserts: {
        articles: [article({ id: "a1", read: true })],
        feeds: [],
        folders: [],
      },
      tombstones: [],
    });

    const stored = await db.get("articles", "a1");
    expect(stored?.read).toBe(true);
    expect(await db.count("articles")).toBe(1);
  });
});

describe("replica-store — applyDelta (tombstones)", () => {
  it("évince un article, un feed et un folder supprimés", async () => {
    await applyDelta(db, {
      upserts: {
        articles: [article({ id: "a1" })],
        feeds: [feed({ id: "feed-1" })],
        folders: [folder({ id: "fold-1" })],
      },
      tombstones: [],
    });
    await applyDelta(db, {
      upserts: { articles: [], feeds: [], folders: [] },
      tombstones: [
        { entityType: "article", entityId: "a1" },
        { entityType: "feed", entityId: "feed-1" },
        { entityType: "folder", entityId: "fold-1" },
      ],
    });

    expect(await db.get("articles", "a1")).toBeUndefined();
    expect(await db.get("feeds", "feed-1")).toBeUndefined();
    expect(await db.get("folders", "fold-1")).toBeUndefined();
  });

  it("est idempotent : un tombstone sur une entité absente ne casse rien", async () => {
    await applyDelta(db, {
      upserts: { articles: [], feeds: [], folders: [] },
      tombstones: [{ entityType: "article", entityId: "absent" }],
    });
    expect(await db.count("articles")).toBe(0);
  });
});

describe("replica-store — applyDelta (protection des non-ackés, #74)", () => {
  it("ignore l'upsert descendant d'un article ayant une entrée outbox en attente", async () => {
    // État local optimiste : a1 lu, mutation empilée mais pas encore ackée.
    await applyDelta(db, {
      upserts: {
        articles: [article({ id: "a1", read: true })],
        feeds: [],
        folders: [],
      },
      tombstones: [],
    });
    await enqueueOutbox(db, {
      kind: "patch",
      articleId: "a1",
      field: "read",
      value: true,
    });

    // Le serveur (qui n'a pas encore reçu la mutation) renvoie a1 non-lu.
    await applyDelta(db, {
      upserts: {
        articles: [article({ id: "a1", read: false })],
        feeds: [],
        folders: [],
      },
      tombstones: [],
    });

    // L'upsert descendant n'a PAS écrasé la mutation locale non-ackée (LWW).
    expect((await db.get("articles", "a1"))?.read).toBe(true);
  });

  it("ignore le tombstone descendant d'un article en attente", async () => {
    await applyDelta(db, {
      upserts: { articles: [article({ id: "a1" })], feeds: [], folders: [] },
      tombstones: [],
    });
    await enqueueOutbox(db, {
      kind: "patch",
      articleId: "a1",
      field: "saved",
      value: true,
    });

    await applyDelta(db, {
      upserts: { articles: [], feeds: [], folders: [] },
      tombstones: [{ entityType: "article", entityId: "a1" }],
    });

    // L'article en attente n'est pas évincé tant que sa mutation n'est pas ackée.
    expect(await db.get("articles", "a1")).toBeDefined();
  });

  it("applique normalement les upserts d'articles SANS entrée en attente", async () => {
    await applyDelta(db, {
      upserts: {
        articles: [article({ id: "a1", read: false })],
        feeds: [],
        folders: [],
      },
      tombstones: [],
    });
    // a2 a une entrée pending, a1 non.
    await enqueueOutbox(db, {
      kind: "patch",
      articleId: "a2",
      field: "read",
      value: true,
    });

    await applyDelta(db, {
      upserts: {
        articles: [article({ id: "a1", read: true })],
        feeds: [],
        folders: [],
      },
      tombstones: [],
    });

    expect((await db.get("articles", "a1"))?.read).toBe(true);
  });
});

describe("replica-store — store content (HTML hors-ligne, #75)", () => {
  it("écrit et relit le HTML d'un article", async () => {
    await writeArticleContent(db, "a1", "<p>Bonjour</p>");
    expect(await readArticleContent(db, "a1")).toBe("<p>Bonjour</p>");
  });

  it("stocke un html null (article sans contenu extrait)", async () => {
    await writeArticleContent(db, "a1", null);
    // Présent (clé écrite) mais html null.
    expect(await readArticleContent(db, "a1")).toBeNull();
  });

  it("renvoie undefined pour un article jamais téléchargé", async () => {
    expect(await readArticleContent(db, "absent")).toBeUndefined();
  });

  it("missingContentIds ne renvoie que les ids absents du store content", async () => {
    await writeArticleContent(db, "a1", "<p>Un</p>");
    // a2 a une clé présente même avec html null → pas « manquant ».
    await writeArticleContent(db, "a2", null);

    const missing = await missingContentIds(db, ["a1", "a2", "a3", "a4"]);
    expect(missing).toEqual(["a3", "a4"]);
  });

  it("clearReplica vide aussi le store content", async () => {
    await writeArticleContent(db, "a1", "<p>Un</p>");
    const { clearReplica } = await import("./replica-store");
    await clearReplica(db);
    expect(await readArticleContent(db, "a1")).toBeUndefined();
  });
});

describe("replica-store — wipe", () => {
  it("deleteReplica efface tout (corpus + curseur)", async () => {
    await applyDelta(db, {
      upserts: { articles: [article({ id: "a1" })], feeds: [], folders: [] },
      tombstones: [],
    });
    await writeSyncCursor(db, 999);
    db.close();

    await deleteReplica();
    const fresh = await openReplica();
    expect(await fresh.count("articles")).toBe(0);
    expect(await readSyncCursor(fresh)).toBeNull();
    fresh.close();
  });
});

describe("replica-store — garbageCollectContent (#81)", () => {
  it("évince le HTML d'un article Read non-Saved, garde le corpus, préserve les métadonnées", async () => {
    await applyDelta(db, {
      upserts: {
        articles: [
          article({ id: "unread" }), // non-lu → reste
          article({ id: "saved", read: true, saved: true }), // lu mais Saved → reste
          article({ id: "read", read: true, saved: false }), // lu non-Saved → évincé
        ],
        feeds: [],
        folders: [],
      },
      tombstones: [],
    });
    await writeArticleContent(db, "unread", "<p>unread</p>");
    await writeArticleContent(db, "saved", "<p>saved</p>");
    await writeArticleContent(db, "read", "<p>read</p>");

    const kept = await garbageCollectContent(db);

    // HTML : le Read-non-Saved est évincé, les deux autres restent.
    expect(await readArticleContent(db, "unread")).toBe("<p>unread</p>");
    expect(await readArticleContent(db, "saved")).toBe("<p>saved</p>");
    expect(await readArticleContent(db, "read")).toBeUndefined();
    // Métadonnées : intactes pour TOUS, y compris le Read-non-Saved.
    expect(await db.get("articles", "read")).toMatchObject({ id: "read" });
    // Renvoie les HTML conservés (pour le recalcul des images référencées).
    expect(kept.sort()).toEqual(["<p>saved</p>", "<p>unread</p>"]);
  });

  it("évince le HTML d'un article dont les métadonnées ont disparu (tombstone)", async () => {
    // Contenu présent mais aucune métadonnée (article tombstoné) → hors corpus.
    await writeArticleContent(db, "orphan", "<p>orphan</p>");
    const kept = await garbageCollectContent(db);
    expect(await readArticleContent(db, "orphan")).toBeUndefined();
    expect(kept).toEqual([]);
  });

  it("ne renvoie pas les HTML null mais conserve leur clé (corpus)", async () => {
    await applyDelta(db, {
      upserts: { articles: [article({ id: "u" })], feeds: [], folders: [] },
      tombstones: [],
    });
    await writeArticleContent(db, "u", null); // dans le corpus, sans contenu extrait.
    const kept = await garbageCollectContent(db);
    expect(kept).toEqual([]); // html null exclu du résultat (rien à référencer).
    expect(await readArticleContent(db, "u")).toBeNull(); // clé conservée.
  });

  it("est idempotent (relancé, n'évince rien de plus)", async () => {
    await applyDelta(db, {
      upserts: {
        articles: [article({ id: "read", read: true })],
        feeds: [],
        folders: [],
      },
      tombstones: [],
    });
    await writeArticleContent(db, "read", "<p>read</p>");
    await garbageCollectContent(db);
    const kept = await garbageCollectContent(db);
    expect(kept).toEqual([]);
    expect(await readArticleContent(db, "read")).toBeUndefined();
  });
});
