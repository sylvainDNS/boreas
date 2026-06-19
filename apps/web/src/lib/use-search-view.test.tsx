import "fake-indexeddb/auto";
import type { ArticleListResponse, SyncFeed } from "@boreas/api-contracts";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppWrapper } from "../test/render";
import { apiFetch } from "./api";
import { resetReplicaSingleton } from "./sync/replica";
import { applyDelta, deleteReplica, openReplica } from "./sync/replica-store";
import { useSearchView } from "./use-search-view";

vi.mock("./api", async (importActual) => {
  const actual = await importActual<typeof import("./api")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedFetch = vi.mocked(apiFetch);

beforeEach(async () => {
  await deleteReplica();
  resetReplicaSingleton();
  // Aucune recherche ne doit toucher le réseau : tout appel API échoue.
  mockedFetch.mockRejectedValue(new Error("offline"));
});

afterEach(() => {
  mockedFetch.mockReset();
  resetReplicaSingleton();
});

function item(
  id: string,
  overrides: Partial<ArticleListResponse["articles"][number]> = {},
): ArticleListResponse["articles"][number] {
  return {
    id,
    feedId: "f1",
    feedName: "Flux 1",
    title: `Titre ${id}`,
    summary: null,
    link: null,
    publishedAt: "2026-01-01T00:00:00.000Z",
    fetchedAt: "2026-01-01T00:00:00.000Z",
    read: false,
    saved: false,
    ...overrides,
  };
}

function syncFeed(over: Partial<SyncFeed> & { id: string }): SyncFeed {
  return {
    id: over.id,
    url: `https://src.example/${over.id}.xml`,
    title: `Flux ${over.id}`,
    status: "ok",
    lastError: null,
    lastCheckAt: null,
    folderId: null,
    rank: "a0",
    unsubscribed: over.unsubscribed ?? false,
  };
}

async function seedReplica(
  articles: ArticleListResponse["articles"],
  feeds: SyncFeed[] = [],
): Promise<void> {
  const db = await openReplica();
  await applyDelta(db, {
    upserts: { articles, feeds, folders: [] },
    tombstones: [],
  });
  db.close();
}

describe("useSearchView", () => {
  it("recherche hors-ligne sur le réplica (titre), sans appel réseau", async () => {
    await seedReplica(
      [
        item("a1", { title: "Le vent du nord" }),
        item("a2", { title: "Tout autre chose" }),
      ],
      [syncFeed({ id: "f1" })],
    );

    const { result } = renderHook(() => useSearchView("vent"), {
      wrapper: createAppWrapper(),
    });

    await waitFor(() =>
      expect(result.current.articles.map((a) => a.id)).toEqual(["a1"]),
    );
    expect(result.current.title).toBe("Recherche : « vent »");
    // Aucun appel réseau pour la recherche (local-first).
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("requête vide : aucune recherche, invite de saisie", async () => {
    await seedReplica([item("a1")], [syncFeed({ id: "f1" })]);
    const { result } = renderHook(() => useSearchView("  "), {
      wrapper: createAppWrapper(),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.articles).toEqual([]);
    expect(result.current.emptyLabel).toBe(
      "Tapez une recherche pour explorer vos articles.",
    );
  });

  it("expose toggle Saved/Read mais pas markAllRead/showRead/refresh", async () => {
    await seedReplica(
      [item("a1", { title: "match" })],
      [syncFeed({ id: "f1" })],
    );
    const { result } = renderHook(() => useSearchView("match"), {
      wrapper: createAppWrapper(),
    });
    await waitFor(() => expect(result.current.articles).toHaveLength(1));
    expect(result.current.onToggleSaved).toBeDefined();
    expect(result.current.onToggleRead).toBeDefined();
    expect(result.current.onMarkAllRead).toBeUndefined();
    expect(result.current.showRead).toBeUndefined();
    expect(result.current.onRefresh).toBeUndefined();
    expect(result.current.hasNextPage).toBe(false);
  });
});
