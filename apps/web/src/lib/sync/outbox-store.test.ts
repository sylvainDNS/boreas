import "fake-indexeddb/auto";
import type { SyncArticle, SyncFeed, SyncFolder } from "@boreas/api-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteOutboxEntry,
  enqueueOutbox,
  markReadInReplica,
  pendingArticleIds,
  readOutbox,
  setArticleFieldInReplica,
} from "./outbox-store";
import {
  applyDelta,
  deleteReplica,
  type OutboxEntry,
  openReplica,
  type ReplicaDb,
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

describe("outbox-store — enqueue / read / delete (FIFO)", () => {
  it("empile et relit les entrées dans l'ordre d'insertion (seq croissant)", async () => {
    await enqueueOutbox(db, {
      kind: "patch",
      articleId: "a1",
      field: "read",
      value: true,
    });
    await enqueueOutbox(db, { kind: "markRead", scope: { scope: "global" } });
    await enqueueOutbox(db, {
      kind: "patch",
      articleId: "a2",
      field: "saved",
      value: true,
    });

    const entries = await readOutbox(db);
    expect(entries.map((e) => e.kind)).toEqual(["patch", "markRead", "patch"]);
    // Les seq sont croissants (auto-increment).
    const seqs = entries.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it("supprime (ack) une entrée par son seq", async () => {
    await enqueueOutbox(db, {
      kind: "patch",
      articleId: "a1",
      field: "read",
      value: true,
    });
    const [entry] = await readOutbox(db);
    expect(entry).toBeDefined();
    await deleteOutboxEntry(db, (entry as OutboxEntry).seq);
    expect(await readOutbox(db)).toHaveLength(0);
  });
});

describe("outbox-store — pendingArticleIds", () => {
  it("renvoie les articleId des entrées patch en attente", async () => {
    await enqueueOutbox(db, {
      kind: "patch",
      articleId: "a1",
      field: "read",
      value: true,
    });
    await enqueueOutbox(db, {
      kind: "patch",
      articleId: "a2",
      field: "saved",
      value: false,
    });
    // Une entrée markRead n'apporte pas d'articleId précis.
    await enqueueOutbox(db, { kind: "markRead", scope: { scope: "global" } });

    const ids = await pendingArticleIds(db);
    expect(ids).toEqual(new Set(["a1", "a2"]));
  });

  it("renvoie un ensemble vide quand l'outbox est vide", async () => {
    expect(await pendingArticleIds(db)).toEqual(new Set());
  });
});

describe("outbox-store — setArticleFieldInReplica (écriture optimiste)", () => {
  it("met à jour le champ read d'un article du réplica", async () => {
    await applyDelta(db, {
      upserts: {
        articles: [article({ id: "a1", read: false })],
        feeds: [],
        folders: [],
      },
      tombstones: [],
    });

    await setArticleFieldInReplica(db, "a1", "read", true);

    expect((await db.get("articles", "a1"))?.read).toBe(true);
  });

  it("met à jour le champ saved sans toucher read", async () => {
    await applyDelta(db, {
      upserts: {
        articles: [article({ id: "a1", read: true, saved: false })],
        feeds: [],
        folders: [],
      },
      tombstones: [],
    });

    await setArticleFieldInReplica(db, "a1", "saved", true);

    const stored = await db.get("articles", "a1");
    expect(stored?.saved).toBe(true);
    expect(stored?.read).toBe(true);
  });

  it("est un no-op si l'article est absent du réplica (vue API #73)", async () => {
    await setArticleFieldInReplica(db, "absent", "read", true);
    expect(await db.get("articles", "absent")).toBeUndefined();
  });
});

describe("outbox-store — markReadInReplica (scopes)", () => {
  it("scope global : passe tous les articles non-lus à read=true", async () => {
    await applyDelta(db, {
      upserts: {
        articles: [
          article({ id: "a1", read: false }),
          article({ id: "a2", read: false }),
        ],
        feeds: [],
        folders: [],
      },
      tombstones: [],
    });

    await markReadInReplica(db, { scope: "global" });

    expect((await db.get("articles", "a1"))?.read).toBe(true);
    expect((await db.get("articles", "a2"))?.read).toBe(true);
  });

  it("scope feed : ne marque que les articles du feed visé", async () => {
    await applyDelta(db, {
      upserts: {
        articles: [
          article({ id: "a1", feedId: "f1", read: false }),
          article({ id: "a2", feedId: "f2", read: false }),
        ],
        feeds: [feed({ id: "f1" }), feed({ id: "f2" })],
        folders: [],
      },
      tombstones: [],
    });

    await markReadInReplica(db, { scope: "feed", feedId: "f1" });

    expect((await db.get("articles", "a1"))?.read).toBe(true);
    expect((await db.get("articles", "a2"))?.read).toBe(false);
  });

  it("scope folder : marque les articles des feeds du dossier", async () => {
    await applyDelta(db, {
      upserts: {
        articles: [
          article({ id: "a1", feedId: "f1", read: false }),
          article({ id: "a2", feedId: "f2", read: false }),
          article({ id: "a3", feedId: "f3", read: false }),
        ],
        feeds: [
          feed({ id: "f1", folderId: "fo1" }),
          feed({ id: "f2", folderId: "fo1" }),
          feed({ id: "f3", folderId: "fo2" }),
        ],
        folders: [folder({ id: "fo1" }), folder({ id: "fo2" })],
      },
      tombstones: [],
    });

    await markReadInReplica(db, { scope: "folder", folderId: "fo1" });

    expect((await db.get("articles", "a1"))?.read).toBe(true);
    expect((await db.get("articles", "a2"))?.read).toBe(true);
    expect((await db.get("articles", "a3"))?.read).toBe(false);
  });
});
