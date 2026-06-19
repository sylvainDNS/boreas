import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../../lib/api";
import { ARTICLES_COUNTS_KEY, ARTICLES_LIST_KEY } from "../../lib/articles";
import { FEEDS_LIST_KEY, type Feed } from "../../lib/feeds";
import type { ApiHandlerContext } from "../../test/api-mock";
import { stubApi } from "../../test/api-mock";
import { createAppWrapper, createTestQueryClient } from "../../test/render";
import { useFeedLifecycle } from "./use-feed-lifecycle";

// `vi.mock` reste dans le fichier de test (hoisting Vitest, convention du repo).
vi.mock("../../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedFetch = vi.mocked(apiFetch);

afterEach(() => {
  mockedFetch.mockReset();
});

function makeFeed(id: string, folderId: string | null = null): Feed {
  return {
    id,
    url: `https://example.com/${id}`,
    title: id,
    status: "ok",
    lastError: null,
    lastCheckAt: null,
    folderId,
    rank: "a0",
  };
}

describe("useFeedLifecycle", () => {
  it("désabonne le feed actif puis retombe sur « Tous les non-lus »", async () => {
    stubApi(mockedFetch, {
      "POST /feeds/:id/unsubscribe": { status: "unsubscribed" },
    });
    const client = createTestQueryClient();
    const wrapper = createAppWrapper({
      initialPath: "/feeds/f1",
      client,
    });
    const { result } = renderHook(() => useFeedLifecycle(), { wrapper });
    await waitFor(() => expect(result.current).not.toBeNull());

    result.current.unsubscribe.mutate(makeFeed("f1"));

    await waitFor(() =>
      expect(result.current.unsubscribe.isSuccess).toBe(true),
    );
    await waitFor(() =>
      expect(result.current.router.state.location.pathname).toBe("/"),
    );
  });

  it("ne navigue pas si le feed désabonné n'est pas le feed actif", async () => {
    stubApi(mockedFetch, {
      "POST /feeds/:id/unsubscribe": { status: "unsubscribed" },
    });
    const client = createTestQueryClient();
    const wrapper = createAppWrapper({
      initialPath: "/feeds/active",
      client,
    });
    const { result } = renderHook(() => useFeedLifecycle(), { wrapper });
    await waitFor(() => expect(result.current).not.toBeNull());

    result.current.unsubscribe.mutate(makeFeed("other"));

    await waitFor(() =>
      expect(result.current.unsubscribe.isSuccess).toBe(true),
    );
    expect(result.current.router.state.location.pathname).toBe("/feeds/active");
  });

  it("invalide feeds + listes + compteurs après un désabonnement", async () => {
    stubApi(mockedFetch, {
      "POST /feeds/:id/unsubscribe": { status: "unsubscribed" },
    });
    const client = createTestQueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const wrapper = createAppWrapper({ initialPath: "/", client });
    const { result } = renderHook(() => useFeedLifecycle(), { wrapper });
    await waitFor(() => expect(result.current).not.toBeNull());

    result.current.unsubscribe.mutate(makeFeed("f1"));
    await waitFor(() =>
      expect(result.current.unsubscribe.isSuccess).toBe(true),
    );

    const keys = invalidate.mock.calls.map((c) => c[0]?.queryKey);
    expect(keys).toContainEqual(FEEDS_LIST_KEY);
    expect(keys).toContainEqual(ARTICLES_LIST_KEY);
    expect(keys).toContainEqual(ARTICLES_COUNTS_KEY);
  });

  it("déplace un feed via la mutation update (folderId cible)", async () => {
    let received: unknown;
    stubApi(mockedFetch, {
      "PATCH /feeds/:id": ({ body }: ApiHandlerContext) => {
        received = body;
        return { id: "f1", title: "f1", folderId: "fold" };
      },
    });
    const client = createTestQueryClient();
    const wrapper = createAppWrapper({ initialPath: "/", client });
    const { result } = renderHook(() => useFeedLifecycle(), { wrapper });
    await waitFor(() => expect(result.current).not.toBeNull());

    result.current.move("f1", "fold");

    await waitFor(() => expect(received).toEqual({ folderId: "fold" }));
  });
});
