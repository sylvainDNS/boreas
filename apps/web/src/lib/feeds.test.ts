import type { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "./api";
import { ARTICLES_COUNTS_KEY, ARTICLES_LIST_KEY } from "./articles";
import {
  deleteFeedMutationOptions,
  FEEDS_LIST_KEY,
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

describe("deleteFeedMutationOptions (#14)", () => {
  it("DELETE /feeds/:id et invalide feeds + listes + compteurs", async () => {
    mockedFetch.mockResolvedValueOnce({ ok: true });
    const { client, invalidateQueries } = fakeQueryClient();
    const opts = deleteFeedMutationOptions(client);

    await opts.mutationFn("f2");
    expect(mockedFetch).toHaveBeenCalledWith("/feeds/f2", {
      method: "DELETE",
    });

    opts.onSuccess();
    const keys = invalidateQueries.mock.calls.map((c) => c[0]?.queryKey);
    expect(keys).toContainEqual(FEEDS_LIST_KEY);
    expect(keys).toContainEqual(ARTICLES_LIST_KEY);
    expect(keys).toContainEqual(ARTICLES_COUNTS_KEY);
  });
});
