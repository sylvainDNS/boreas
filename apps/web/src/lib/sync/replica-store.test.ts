import "fake-indexeddb/auto";
import type { SyncArticle, SyncFeed, SyncFolder } from "@boreas/api-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyDelta,
  deleteReplica,
  openReplica,
  type ReplicaDb,
  readSyncCursor,
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
