import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { getReplica, resetReplicaSingleton, wipeReplica } from "./replica";
import {
  deleteReplica,
  readSyncCursor,
  writeSyncCursor,
} from "./replica-store";

afterEach(async () => {
  resetReplicaSingleton();
  await deleteReplica();
  resetReplicaSingleton();
});

describe("wipeReplica", () => {
  it("supprime le réplica et le rouvre vierge (curseur effacé → resync since=0)", async () => {
    const db = await getReplica();
    await writeSyncCursor(db, 12_345);
    expect(await readSyncCursor(db)).toBe(12_345);

    await wipeReplica();

    const fresh = await getReplica();
    expect(fresh).not.toBe(db); // nouvelle connexion après réinitialisation du singleton
    expect(await readSyncCursor(fresh)).toBeNull();
  });
});
