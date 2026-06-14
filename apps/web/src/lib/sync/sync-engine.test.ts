import "fake-indexeddb/auto";
import type { SyncArticle, SyncResponse } from "@boreas/api-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api";
import { enqueueOutbox, type PushOutbox, readOutbox } from "./outbox-store";
import {
  deleteReplica,
  openReplica,
  type ReplicaDb,
  readSyncCursor,
} from "./replica-store";
import { runSync } from "./sync-engine";

function art(id: string, read = false): SyncArticle {
  return {
    id,
    feedId: "feed-1",
    feedName: "Mon flux",
    title: `Titre ${id}`,
    summary: null,
    link: null,
    publishedAt: null,
    fetchedAt: "2026-06-05T12:00:00Z",
    read,
    saved: false,
  };
}

function emptyPage(over: Partial<SyncResponse> = {}): SyncResponse {
  return {
    upserts: { articles: [], feeds: [], folders: [] },
    tombstones: [],
    cursor: null,
    complete: true,
    stale: false,
    ...over,
  };
}

let db: ReplicaDb;

beforeEach(async () => {
  await deleteReplica();
  db = await openReplica();
});

afterEach(() => {
  db.close();
});

describe("sync-engine — pull initial", () => {
  it("appelle /sync sans since quand le réplica est vide", async () => {
    const pull = vi.fn(async () => emptyPage());
    await runSync(db, pull);
    expect(pull).toHaveBeenCalledWith(0);
  });

  it("écrit les upserts dans le réplica et persiste le curseur", async () => {
    const pull = vi.fn(async () =>
      emptyPage({
        upserts: { articles: [art("a1")], feeds: [], folders: [] },
        cursor: 500,
      }),
    );
    await runSync(db, pull);
    expect(await db.get("articles", "a1")).toMatchObject({ id: "a1" });
    expect(await readSyncCursor(db)).toBe(500);
  });
});

describe("sync-engine — pagination du pull initial", () => {
  it("enchaîne les pages tant que complete=false, en repassant le curseur", async () => {
    const pull = vi
      .fn<(since: number) => Promise<SyncResponse>>()
      .mockResolvedValueOnce(
        emptyPage({
          upserts: { articles: [art("a1")], feeds: [], folders: [] },
          cursor: 100,
          complete: false,
        }),
      )
      .mockResolvedValueOnce(
        emptyPage({
          upserts: { articles: [art("a2")], feeds: [], folders: [] },
          cursor: 200,
          complete: true,
        }),
      );

    await runSync(db, pull);

    expect(pull).toHaveBeenNthCalledWith(1, 0);
    expect(pull).toHaveBeenNthCalledWith(2, 100);
    expect(await db.get("articles", "a1")).toBeDefined();
    expect(await db.get("articles", "a2")).toBeDefined();
    expect(await readSyncCursor(db)).toBe(200);
  });
});

describe("sync-engine — pull incrémental", () => {
  it("repart du curseur persisté", async () => {
    // 1er pull pose le curseur à 500.
    await runSync(db, async () => emptyPage({ cursor: 500 }));
    const pull = vi.fn(async () => emptyPage({ cursor: null }));
    await runSync(db, pull);
    expect(pull).toHaveBeenCalledWith(500);
  });

  it("n'écrase pas le curseur quand la page est vide (cursor null)", async () => {
    await runSync(db, async () => emptyPage({ cursor: 500 }));
    await runSync(db, async () => emptyPage({ cursor: null }));
    expect(await readSyncCursor(db)).toBe(500);
  });
});

describe("sync-engine — curseur périmé (stale)", () => {
  it("wipe le réplica et resync complet depuis since=0", async () => {
    // État initial : du contenu et un curseur élevé.
    await runSync(db, async () =>
      emptyPage({
        upserts: { articles: [art("vieux")], feeds: [], folders: [] },
        cursor: 9999,
      }),
    );

    const pull = vi
      .fn<(since: number) => Promise<SyncResponse>>()
      // 1er appel (incrémental depuis 9999) → périmé.
      .mockResolvedValueOnce(emptyPage({ stale: true }))
      // 2e appel : resync complet depuis 0.
      .mockResolvedValueOnce(
        emptyPage({
          upserts: { articles: [art("neuf")], feeds: [], folders: [] },
          cursor: 12000,
        }),
      );

    await runSync(db, pull);

    expect(pull).toHaveBeenNthCalledWith(1, 9999);
    expect(pull).toHaveBeenNthCalledWith(2, 0);
    // L'ancien contenu a été wipé, le neuf est là.
    expect(await db.get("articles", "vieux")).toBeUndefined();
    expect(await db.get("articles", "neuf")).toBeDefined();
    expect(await readSyncCursor(db)).toBe(12000);
  });
});

describe("sync-engine — push-avant-pull (#74)", () => {
  it("flushe l'outbox AVANT de pull le delta", async () => {
    await enqueueOutbox(db, {
      kind: "patch",
      articleId: "a1",
      field: "read",
      value: true,
    });

    const order: string[] = [];
    const push: PushOutbox = vi.fn(async () => {
      order.push("push");
    });
    const pull = vi.fn(async () => {
      order.push("pull");
      return emptyPage({ cursor: 100 });
    });

    await runSync(db, pull, push);

    expect(order).toEqual(["push", "pull"]);
    // L'entrée poussée est ackée.
    expect(await readOutbox(db)).toHaveLength(0);
  });

  it("sur 401 au push : n'enchaîne PAS le pull et conserve l'outbox", async () => {
    await enqueueOutbox(db, {
      kind: "patch",
      articleId: "a1",
      field: "read",
      value: true,
    });

    const push: PushOutbox = vi.fn(async () => {
      throw new ApiError(401);
    });
    const pull = vi.fn(async () => emptyPage());

    await expect(runSync(db, pull, push)).rejects.toBeInstanceOf(ApiError);
    expect(pull).not.toHaveBeenCalled();
    // Outbox conservée : re-flush après ré-auth.
    expect(await readOutbox(db)).toHaveLength(1);
  });

  it("outbox vide : pull normal (pas d'appel push)", async () => {
    const push: PushOutbox = vi.fn(async () => {});
    await runSync(db, async () => emptyPage({ cursor: 1 }), push);
    expect(push).not.toHaveBeenCalled();
  });
});

describe("sync-engine — robustesse", () => {
  it("propage l'erreur réseau sans corrompre le curseur", async () => {
    await runSync(db, async () => emptyPage({ cursor: 500 }));
    await expect(
      runSync(db, async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    // Le curseur reste sur la dernière sync réussie.
    expect(await readSyncCursor(db)).toBe(500);
  });
});
