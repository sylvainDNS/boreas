import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api";
import {
  enqueueOutbox,
  flushOutbox,
  type PushOutbox,
  readOutbox,
} from "./outbox-store";
import { deleteReplica, openReplica, type ReplicaDb } from "./replica-store";

let db: ReplicaDb;

beforeEach(async () => {
  await deleteReplica();
  db = await openReplica();
});

afterEach(() => {
  db.close();
});

describe("flushOutbox — ordre et ack", () => {
  it("rejoue les entrées dans l'ordre FIFO puis les ack (supprime) au succès", async () => {
    await enqueueOutbox(db, {
      kind: "patch",
      articleId: "a1",
      field: "read",
      value: true,
    });
    await enqueueOutbox(db, { kind: "markRead", scope: { scope: "global" } });

    const seen: string[] = [];
    const push: PushOutbox = vi.fn(async (entry) => {
      seen.push(entry.kind);
    });

    await flushOutbox(db, push);

    expect(seen).toEqual(["patch", "markRead"]);
    // Tout est acké : l'outbox est vide.
    expect(await readOutbox(db)).toHaveLength(0);
  });

  it("mark-all-read offline = une seule requête de scope par entrée", async () => {
    await enqueueOutbox(db, {
      kind: "markRead",
      scope: { scope: "feed", feedId: "f1" },
    });

    const push = vi.fn<PushOutbox>(async () => {});
    await flushOutbox(db, push);

    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "markRead",
        scope: { scope: "feed", feedId: "f1" },
      }),
    );
  });
});

describe("flushOutbox — 401 (ré-auth)", () => {
  it("s'arrête sur 401 sans drop : l'entrée et les suivantes survivent", async () => {
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
      value: true,
    });

    const push = vi.fn<PushOutbox>(async () => {
      throw new ApiError(401);
    });

    await expect(flushOutbox(db, push)).rejects.toBeInstanceOf(ApiError);

    // Rien n'est acké : l'outbox conserve ses deux entrées pour re-flush post-login.
    expect(await readOutbox(db)).toHaveLength(2);
    // On n'insiste pas après le 401 (arrêt à la première entrée).
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("re-flush après ré-auth pousse à nouveau les entrées conservées", async () => {
    await enqueueOutbox(db, {
      kind: "patch",
      articleId: "a1",
      field: "read",
      value: true,
    });

    // 1re passe : 401 → conservé.
    const push401 = vi.fn<PushOutbox>(async () => {
      throw new ApiError(401);
    });
    await expect(flushOutbox(db, push401)).rejects.toBeInstanceOf(ApiError);
    expect(await readOutbox(db)).toHaveLength(1);

    // 2e passe (après login) : succès → acké.
    const pushOk = vi.fn<PushOutbox>(async () => {});
    await flushOutbox(db, pushOk);
    expect(pushOk).toHaveBeenCalledTimes(1);
    expect(await readOutbox(db)).toHaveLength(0);
  });
});

describe("flushOutbox — erreur réseau (hors-ligne)", () => {
  it("laisse l'entrée non-ackée pour la prochaine passe et propage l'erreur", async () => {
    await enqueueOutbox(db, {
      kind: "patch",
      articleId: "a1",
      field: "read",
      value: true,
    });

    const push = vi.fn<PushOutbox>(async () => {
      throw new TypeError("Failed to fetch");
    });

    await expect(flushOutbox(db, push)).rejects.toThrow();
    expect(await readOutbox(db)).toHaveLength(1);
  });

  it("ack les entrées poussées avant l'échec, garde le reste", async () => {
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
      value: true,
    });

    let calls = 0;
    const push = vi.fn<PushOutbox>(async () => {
      calls += 1;
      if (calls === 2) throw new TypeError("Failed to fetch");
    });

    await expect(flushOutbox(db, push)).rejects.toThrow();
    // 1re ackée, 2e conservée.
    const remaining = await readOutbox(db);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ kind: "patch", articleId: "a2" });
  });

  it("ne fait rien quand l'outbox est vide", async () => {
    const push = vi.fn<PushOutbox>(async () => {});
    await flushOutbox(db, push);
    expect(push).not.toHaveBeenCalled();
  });
});
