import "fake-indexeddb/auto";
import type { ArticleListItem } from "@boreas/api-contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  markAllReadMutationOptions,
  toggleArticleReadMutationOptions,
  toggleArticleSavedMutationOptions,
  UNREAD_LOCAL_QUERY_KEY,
} from "./articles";
import { readOutbox } from "./sync/outbox-store";
import { getReplica, resetReplicaSingleton } from "./sync/replica";
import { applyDelta, deleteReplica } from "./sync/replica-store";

// On mocke le flush best-effort : la mutation hors-ligne ne doit pas dépendre du
// réseau. On vérifie séparément qu'elle l'invoque (sync best-effort).
vi.mock("./sync/replica", async (importActual) => {
  const actual = await importActual<typeof import("./sync/replica")>();
  return { ...actual, syncReplica: vi.fn() };
});

const { syncReplica } = await import("./sync/replica");
const mockedSync = vi.mocked(syncReplica);

function item(
  over: Partial<ArticleListItem> & { id: string },
): ArticleListItem {
  return {
    id: over.id,
    feedId: over.feedId ?? "f1",
    feedName: over.feedName ?? "Flux 1",
    title: over.title ?? `Titre ${over.id}`,
    summary: over.summary ?? null,
    link: over.link ?? null,
    publishedAt: over.publishedAt ?? null,
    fetchedAt: over.fetchedAt ?? "2026-06-05T12:00:00Z",
    read: over.read ?? false,
    saved: over.saved ?? false,
  };
}

async function seed(articles: ArticleListItem[]): Promise<void> {
  const db = await getReplica();
  await applyDelta(db, {
    upserts: { articles, feeds: [], folders: [] },
    tombstones: [],
  });
}

let client: QueryClient;

beforeEach(async () => {
  await deleteReplica();
  resetReplicaSingleton();
  mockedSync.mockReset();
  // Par défaut, le flush best-effort « réussit » sans rien faire (online OK).
  mockedSync.mockResolvedValue(undefined);
  client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
});

afterEach(() => {
  resetReplicaSingleton();
  client.clear();
});

describe("toggleArticleReadMutationOptions — écriture optimiste réplica + outbox", () => {
  it("hors-ligne : applique read au réplica, empile l'outbox, et NE rejette PAS", async () => {
    await seed([item({ id: "a1", read: false })]);
    // Hors-ligne : le flush best-effort échoue (réseau).
    mockedSync.mockRejectedValue(new Error("offline"));

    const opts = toggleArticleReadMutationOptions(client);
    // onMutate (optimiste) puis mutationFn (best-effort, ne doit pas throw).
    const ctx = await opts.onMutate({ id: "a1", read: true });
    await expect(
      opts.mutationFn({ id: "a1", read: true }),
    ).resolves.toBeDefined();

    const db = await getReplica();
    expect((await db.get("articles", "a1"))?.read).toBe(true);
    const outbox = await readOutbox(db);
    expect(outbox).toEqual([
      expect.objectContaining({
        kind: "patch",
        articleId: "a1",
        field: "read",
        value: true,
      }),
    ]);
    // Le contexte onMutate est défini (snapshot pour rollback du cache).
    expect(ctx).toBeDefined();
  });

  it("invalide la query river non-lus après écriture réplica", async () => {
    await seed([item({ id: "a1", read: false })]);
    const spy = vi.spyOn(client, "invalidateQueries");

    const opts = toggleArticleReadMutationOptions(client);
    await opts.onMutate({ id: "a1", read: true });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: UNREAD_LOCAL_QUERY_KEY }),
    );
  });
});

describe("toggleArticleSavedMutationOptions — écriture optimiste réplica + outbox", () => {
  it("hors-ligne : applique saved au réplica et empile l'outbox", async () => {
    await seed([item({ id: "a1", saved: false })]);
    mockedSync.mockRejectedValue(new Error("offline"));

    const opts = toggleArticleSavedMutationOptions(client);
    await opts.onMutate({ id: "a1", saved: true });
    await expect(
      opts.mutationFn({ id: "a1", saved: true }),
    ).resolves.toBeDefined();

    const db = await getReplica();
    expect((await db.get("articles", "a1"))?.saved).toBe(true);
    expect(await readOutbox(db)).toEqual([
      expect.objectContaining({ kind: "patch", field: "saved", value: true }),
    ]);
  });
});

describe("markAllReadMutationOptions — mark-all-read hors-ligne", () => {
  it("hors-ligne : marque le scope au réplica et empile UNE entrée markRead", async () => {
    await seed([
      item({ id: "a1", feedId: "f1", read: false }),
      item({ id: "a2", feedId: "f1", read: false }),
    ]);
    mockedSync.mockRejectedValue(new Error("offline"));

    const opts = markAllReadMutationOptions(client);
    await opts.onMutate({ scope: "global" });
    await expect(opts.mutationFn({ scope: "global" })).resolves.toBeDefined();

    const db = await getReplica();
    expect((await db.get("articles", "a1"))?.read).toBe(true);
    expect((await db.get("articles", "a2"))?.read).toBe(true);
    const outbox = await readOutbox(db);
    // Une SEULE entrée de portée (pas N patchs).
    expect(outbox).toEqual([
      expect.objectContaining({ kind: "markRead", scope: { scope: "global" } }),
    ]);
  });
});
