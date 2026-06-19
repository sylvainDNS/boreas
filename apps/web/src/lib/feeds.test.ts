import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "./api";
import { ARTICLES_COUNTS_KEY, ARTICLES_LIST_KEY } from "./articles";
import {
  FEEDS_LIST_KEY,
  type Feed,
  moveAndRankFeedMutationOptions,
  reorderFeedMutationOptions,
  submitFeedUrl,
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

describe("submitFeedUrl (#118)", () => {
  it("ajoute folderId au corps quand il est fourni", async () => {
    mockedFetch.mockResolvedValueOnce({
      feed: { id: "f1", url: "https://blog.example/feed.xml", title: "Blog" },
      articleCount: 0,
    });

    await submitFeedUrl("https://blog.example/feed.xml", "fo1");

    expect(mockedFetch).toHaveBeenCalledWith("/feeds", {
      method: "POST",
      body: JSON.stringify({
        url: "https://blog.example/feed.xml",
        folderId: "fo1",
      }),
    });
  });

  it("omet folderId du corps quand il est absent", async () => {
    mockedFetch.mockResolvedValueOnce({
      feed: { id: "f1", url: "https://blog.example/feed.xml", title: "Blog" },
      articleCount: 0,
    });

    await submitFeedUrl("https://blog.example/feed.xml");

    expect(mockedFetch).toHaveBeenCalledWith("/feeds", {
      method: "POST",
      body: JSON.stringify({ url: "https://blog.example/feed.xml" }),
    });
  });

  it("omet folderId quand il vaut null (zone sans dossier explicite)", async () => {
    mockedFetch.mockResolvedValueOnce({
      feed: { id: "f1", url: "https://blog.example/feed.xml", title: "Blog" },
      articleCount: 0,
    });

    await submitFeedUrl("https://blog.example/feed.xml", null);

    expect(mockedFetch).toHaveBeenCalledWith("/feeds", {
      method: "POST",
      body: JSON.stringify({ url: "https://blog.example/feed.xml" }),
    });
  });
});

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

describe("moveAndRankFeedMutationOptions (#112)", () => {
  it("PATCH /feeds/:id {folderId, rank} en un seul appel atomique", async () => {
    mockedFetch.mockResolvedValueOnce({
      id: "u0",
      folderId: "fo1",
      rank: "a0V",
    });
    const { client } = seedFeeds();
    const opts = moveAndRankFeedMutationOptions(client);

    await opts.mutationFn({ id: "u0", folderId: "fo1", rank: "a0V" });
    expect(mockedFetch).toHaveBeenCalledWith("/feeds/u0", {
      method: "PATCH",
      body: JSON.stringify({ folderId: "fo1", rank: "a0V" }),
    });
  });

  it("onMutate : réécrit folderId + rang du feed et re-trie la liste GLOBALE", async () => {
    const { client } = seedFeeds();
    const opts = moveAndRankFeedMutationOptions(client);

    // Déplace "u0" (sans dossier) dans "fo1" entre c0 (a0) et c1 (a1).
    await opts.onMutate({ id: "u0", folderId: "fo1", rank: "a0V" });

    // u1 reste seul sans dossier ; u0 s'intercale dans fo1 entre c0 et c1.
    expect(feedOrder(client).map((f) => f.id)).toEqual([
      "u1",
      "c0",
      "u0",
      "c1",
    ]);
    const moved = client
      .getQueryData<Feed[]>(FEEDS_LIST_KEY)
      ?.find((f) => f.id === "u0");
    expect(moved?.folderId).toBe("fo1");
    expect(moved?.rank).toBe("a0V");
  });

  it("onError : restaure folderId ET rang du seul feed concerné, puis re-trie", async () => {
    const { client } = seedFeeds();
    const opts = moveAndRankFeedMutationOptions(client);

    const context = await opts.onMutate({
      id: "u0",
      folderId: "fo1",
      rank: "a0V",
    });
    expect(feedOrder(client).map((f) => f.id)).toEqual([
      "u1",
      "c0",
      "u0",
      "c1",
    ]);

    opts.onError(
      new Error("boom"),
      { id: "u0", folderId: "fo1", rank: "a0V" },
      context,
    );

    // Retour à l'état initial : u0 redevient sans dossier avec son rang a0.
    const restored = client
      .getQueryData<Feed[]>(FEEDS_LIST_KEY)
      ?.find((f) => f.id === "u0");
    expect(restored?.folderId).toBeNull();
    expect(restored?.rank).toBe("a0");
    expect(feedOrder(client).map((f) => f.id)).toEqual([
      "u0",
      "u1",
      "c0",
      "c1",
    ]);
  });

  it("onSettled : invalide feeds + listes + compteurs (comme le move #13)", () => {
    const { client, invalidateQueries } = fakeQueryClient();
    const opts = moveAndRankFeedMutationOptions(client);

    opts.onSettled();
    const keys = invalidateQueries.mock.calls.map((c) => c[0]?.queryKey);
    expect(keys).toContainEqual(FEEDS_LIST_KEY);
    expect(keys).toContainEqual(ARTICLES_LIST_KEY);
    expect(keys).toContainEqual(ARTICLES_COUNTS_KEY);
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
