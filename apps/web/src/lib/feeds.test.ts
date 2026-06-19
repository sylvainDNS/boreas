import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "./api";
import { ARTICLES_COUNTS_KEY, ARTICLES_LIST_KEY } from "./articles";
import {
  FEEDS_LIST_KEY,
  type Feed,
  reorderFeedMutationOptions,
  unsubscribeFeedMutationOptions,
} from "./feeds";

// On mocke le transport bas niveau ; toute la logique des mutationOptions
// (chemin, méthode, invalidations) reste réelle.
vi.mock("./api", async (importActual) => {
  const actual = await importActual<typeof import("./api")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedFetch = vi.mocked(apiFetch);

/** Faux QueryClient minimal : on observe les invalidations déclenchées. */
function fakeQueryClient() {
  const invalidateQueries = vi.fn();
  return {
    client: { invalidateQueries } as unknown as QueryClient,
    invalidateQueries,
  };
}

afterEach(() => {
  mockedFetch.mockReset();
});

/** Feed minimal pour les tests de cache (champs non pertinents au repos). */
function feed(id: string, folderId: string | null, rank: string): Feed {
  return {
    id,
    url: `https://src.example/${id}.xml`,
    title: id,
    status: "ok",
    lastError: null,
    lastCheckAt: null,
    folderId,
    rank,
  };
}

function seedFeeds(): { client: QueryClient; initial: Feed[] } {
  const client = new QueryClient();
  // Deux conteneurs : zone sans dossier (a0,a1) + dossier "fo1" (a0,a1).
  const initial: Feed[] = [
    feed("u0", null, "a0"),
    feed("u1", null, "a1"),
    feed("c0", "fo1", "a0"),
    feed("c1", "fo1", "a1"),
  ];
  client.setQueryData<Feed[]>(FEEDS_LIST_KEY, initial);
  return { client, initial };
}

function feedOrder(client: QueryClient): { id: string; rank: string }[] {
  return (client.getQueryData<Feed[]>(FEEDS_LIST_KEY) ?? []).map((f) => ({
    id: f.id,
    rank: f.rank,
  }));
}

describe("reorderFeedMutationOptions (#111)", () => {
  it("PATCH /feeds/:id {rank} (le serveur écrit le rang verbatim)", async () => {
    mockedFetch.mockResolvedValueOnce({ id: "u0", rank: "a0V" });
    const { client } = seedFeeds();
    const opts = reorderFeedMutationOptions(client);

    await opts.mutationFn({ id: "u0", rank: "a0V" });
    expect(mockedFetch).toHaveBeenCalledWith("/feeds/u0", {
      method: "PATCH",
      body: JSON.stringify({ rank: "a0V" }),
    });
  });

  it("onMutate : réécrit le rang et re-trie la liste GLOBALE par (folderId, rank, id)", async () => {
    const { client } = seedFeeds();
    const opts = reorderFeedMutationOptions(client);

    // Déplace "u0" après "u1" dans la zone sans dossier (rang entre a1 et la fin).
    await opts.onMutate({ id: "u0", rank: "a1V" });

    // Re-tri cohérent avec GET : folderId (null avant "fo1"), puis rang, puis id.
    expect(feedOrder(client).map((f) => f.id)).toEqual([
      "u1",
      "u0",
      "c0",
      "c1",
    ]);
    expect(feedOrder(client).find((f) => f.id === "u0")?.rank).toBe("a1V");
  });

  it("onError : restaure uniquement le rang du feed concerné et re-trie", async () => {
    const { client } = seedFeeds();
    const opts = reorderFeedMutationOptions(client);

    const context = await opts.onMutate({ id: "u0", rank: "a1V" });
    expect(feedOrder(client).map((f) => f.id)).toEqual([
      "u1",
      "u0",
      "c0",
      "c1",
    ]);

    opts.onError(new Error("boom"), { id: "u0", rank: "a1V" }, context);

    // Retour à l'ordre initial (rang u0 restauré à a0).
    expect(feedOrder(client)).toEqual([
      { id: "u0", rank: "a0" },
      { id: "u1", rank: "a1" },
      { id: "c0", rank: "a0" },
      { id: "c1", rank: "a1" },
    ]);
  });

  it("onSettled : invalide UNIQUEMENT la liste des feeds (pas les compteurs)", () => {
    const { client, invalidateQueries } = fakeQueryClient();
    const opts = reorderFeedMutationOptions(client);

    opts.onSettled();
    const keys = invalidateQueries.mock.calls.map((c) => c[0]?.queryKey);
    expect(keys).toContainEqual(FEEDS_LIST_KEY);
    expect(keys).not.toContainEqual(ARTICLES_COUNTS_KEY);
    expect(keys).not.toContainEqual(ARTICLES_LIST_KEY);
  });
});

describe("unsubscribeFeedMutationOptions (#14)", () => {
  it("POST /feeds/:id/unsubscribe et invalide feeds + listes + compteurs", async () => {
    mockedFetch.mockResolvedValueOnce({ id: "f1", unsubscribed: true });
    const { client, invalidateQueries } = fakeQueryClient();
    const opts = unsubscribeFeedMutationOptions(client);

    await opts.mutationFn("f1");
    expect(mockedFetch).toHaveBeenCalledWith("/feeds/f1/unsubscribe", {
      method: "POST",
    });

    opts.onSuccess();
    const keys = invalidateQueries.mock.calls.map((c) => c[0]?.queryKey);
    expect(keys).toContainEqual(FEEDS_LIST_KEY);
    expect(keys).toContainEqual(ARTICLES_LIST_KEY);
    expect(keys).toContainEqual(ARTICLES_COUNTS_KEY);
  });
});
