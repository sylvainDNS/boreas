import "fake-indexeddb/auto";
import type { SyncArticle, SyncResponse } from "@boreas/api-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api";
import { enqueueOutbox, type PushOutbox, readOutbox } from "./outbox-store";
import {
  deleteReplica,
  openReplica,
  type ReplicaDb,
  readArticleContent,
  readSyncCursor,
  writeArticleContent,
} from "./replica-store";
import { type FetchContent, runSync } from "./sync-engine";

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
  localStorage.clear(); // évite la fuite de la préférence Wi-Fi-only entre cas.
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

describe("sync-engine — pré-téléchargement du contenu (#75)", () => {
  it("pré-télécharge le HTML des non-lus ∪ Saved manquant et le stocke", async () => {
    const pull = vi.fn(async () =>
      emptyPage({
        upserts: {
          articles: [
            art("unread-1", false),
            { ...art("saved-1", true), saved: true },
            art("read-1", true), // lu non-Saved : hors corpus offline
          ],
          feeds: [],
          folders: [],
        },
        cursor: 100,
      }),
    );

    const requested: string[][] = [];
    const fetchContent: FetchContent = vi.fn(async (ids: string[]) => {
      requested.push([...ids].sort());
      return ids.map((id) => ({ id, html: `<p>${id}</p>` }));
    });

    await runSync(db, pull, undefined, fetchContent);

    // Le corpus ciblé = non-lus ∪ Saved (pas le lu non-Saved).
    expect(requested).toEqual([["saved-1", "unread-1"]]);
    expect(await readArticleContent(db, "unread-1")).toBe("<p>unread-1</p>");
    expect(await readArticleContent(db, "saved-1")).toBe("<p>saved-1</p>");
    expect(await readArticleContent(db, "read-1")).toBeUndefined();
  });

  it("ne re-télécharge pas un contenu déjà en store", async () => {
    // 1ère passe : télécharge unread-1.
    const pull1 = vi.fn(async () =>
      emptyPage({
        upserts: { articles: [art("unread-1", false)], feeds: [], folders: [] },
        cursor: 100,
      }),
    );
    const fetch1: FetchContent = vi.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, html: `<p>${id}</p>` })),
    );
    await runSync(db, pull1, undefined, fetch1);

    // 2ᵉ passe : unread-1 toujours non-lu, mais déjà en store → pas de re-fetch.
    const pull2 = vi.fn(async () => emptyPage({ cursor: null }));
    const fetch2: FetchContent = vi.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, html: `<p>${id}</p>` })),
    );
    await runSync(db, pull2, undefined, fetch2);

    expect(fetch2).not.toHaveBeenCalled();
  });

  it("stocke html:null pour un article sans contenu (et ne le re-demande pas)", async () => {
    const pull = vi.fn(async () =>
      emptyPage({
        upserts: { articles: [art("u1", false)], feeds: [], folders: [] },
        cursor: 100,
      }),
    );
    const fetchContent: FetchContent = vi.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, html: null })),
    );
    await runSync(db, pull, undefined, fetchContent);

    // Présent (clé écrite) avec html null → ne sera plus re-demandé.
    expect(await readArticleContent(db, "u1")).toBeNull();
  });

  it("avale silencieusement une erreur réseau du pré-téléchargement (offline)", async () => {
    const pull = vi.fn(async () =>
      emptyPage({
        upserts: { articles: [art("u1", false)], feeds: [], folders: [] },
        cursor: 100,
      }),
    );
    const fetchContent: FetchContent = vi.fn(async () => {
      throw new Error("offline");
    });

    // Le pré-téléchargement ne doit pas faire échouer la sync (delta déjà appliqué).
    await expect(
      runSync(db, pull, undefined, fetchContent),
    ).resolves.toBeUndefined();
    expect(await readSyncCursor(db)).toBe(100);
    expect(await readArticleContent(db, "u1")).toBeUndefined();
  });

  it("pré-chauffe les images du HTML téléchargé dans le Cache Storage (#77)", async () => {
    const added: string[] = [];
    const fakeCache = {
      match: vi.fn(async () => undefined),
      add: vi.fn(async (url: string) => {
        added.push(url);
      }),
    };
    const original = (globalThis as { caches?: unknown }).caches;
    (globalThis as { caches?: unknown }).caches = {
      open: vi.fn(async () => fakeCache),
    };

    const pull = vi.fn(async () =>
      emptyPage({
        upserts: { articles: [art("u1", false)], feeds: [], folders: [] },
        cursor: 100,
      }),
    );
    const fetchContent: FetchContent = vi.fn(async (ids: string[]) =>
      ids.map((id) => ({
        id,
        html: `<p>texte</p><img src="/api/img?u=${id}&sig=zzz"><img src="https://cdn/x.png">`,
      })),
    );

    await runSync(db, pull, undefined, fetchContent);

    // Seule l'image proxifiée est pré-chauffée (pas l'image externe non /api/img).
    expect(added).toEqual(["/api/img?u=u1&sig=zzz"]);

    (globalThis as { caches?: unknown }).caches = original;
  });

  it("borne le batch (lots successifs) pour un gros corpus", async () => {
    const many = Array.from({ length: 70 }, (_, i) => art(`u${i}`, false));
    const pull = vi.fn(async () =>
      emptyPage({
        upserts: { articles: many, feeds: [], folders: [] },
        cursor: 100,
      }),
    );
    const batchSizes: number[] = [];
    const fetchContent: FetchContent = vi.fn(async (ids: string[]) => {
      batchSizes.push(ids.length);
      return ids.map((id) => ({ id, html: `<p>${id}</p>` }));
    });

    await runSync(db, pull, undefined, fetchContent);

    // Plusieurs lots bornés (aucun > 50), couvrant les 70 articles.
    expect(batchSizes.length).toBeGreaterThan(1);
    expect(Math.max(...batchSizes)).toBeLessThanOrEqual(50);
    expect(batchSizes.reduce((a, b) => a + b, 0)).toBe(70);
  });
});

describe("sync-engine — GC du contenu local (#81)", () => {
  it("évince le HTML d'un article devenu Read non-Saved via le delta (métadonnées intactes)", async () => {
    // Passe 1 : a1 non-lu, contenu pré-téléchargé.
    await runSync(
      db,
      async () =>
        emptyPage({
          upserts: { articles: [art("a1", false)], feeds: [], folders: [] },
          cursor: 100,
        }),
      undefined,
      async (ids) => ids.map((id) => ({ id, html: `<p>${id}</p>` })),
    );
    expect(await readArticleContent(db, "a1")).toBe("<p>a1</p>");

    // Passe 2 : a1 passe Read non-Saved (lu ailleurs) → le GC évince son HTML.
    await runSync(db, async () =>
      emptyPage({
        upserts: { articles: [art("a1", true)], feeds: [], folders: [] },
        cursor: 200,
      }),
    );

    expect(await readArticleContent(db, "a1")).toBeUndefined(); // HTML évincé
    expect(await db.get("articles", "a1")).toMatchObject({ id: "a1" }); // métadonnées gardées
  });

  it("réconcilie le cache d'images : supprime celles d'un contenu évincé, garde celles encore référencées", async () => {
    const deleted: string[] = [];
    const keysUrls = ["/api/img?u=a1&sig=x", "/api/img?u=a2&sig=y"];
    const fakeCache = {
      match: async () => undefined,
      add: async () => {},
      keys: async () =>
        keysUrls.map((u) => new Request(`https://app.test${u}`)),
      delete: async (req: Request) => {
        const url = new URL(req.url);
        deleted.push(`${url.pathname}${url.search}`);
        return true;
      },
    };
    const original = (globalThis as { caches?: unknown }).caches;
    (globalThis as { caches?: unknown }).caches = {
      open: async () => fakeCache,
    };

    // a1 (non-lu) référence img a1 ; a2 référence img a2. Les deux ont leur contenu.
    await writeArticleContent(db, "a1", '<img src="/api/img?u=a1&sig=x">');
    await writeArticleContent(db, "a2", '<img src="/api/img?u=a2&sig=y">');
    // a1 reste non-lu, a2 devient Read non-Saved → son contenu (et son image) sortent.
    await runSync(db, async () =>
      emptyPage({
        upserts: {
          articles: [art("a1", false), art("a2", true)],
          feeds: [],
          folders: [],
        },
        cursor: 100,
      }),
    );

    // L'image de a2 (contenu évincé) est supprimée ; celle de a1 (encore référencée) reste.
    expect(deleted).toEqual(["/api/img?u=a2&sig=y"]);

    (globalThis as { caches?: unknown }).caches = original;
  });
});
