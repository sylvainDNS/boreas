import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "./api";
import {
  FOLDERS_LIST_KEY,
  type Folder,
  reorderFolderMutationOptions,
} from "./folders";

// On mocke le transport bas niveau ; toute la logique des mutationOptions
// (chemin, méthode, optimisme, rollback, invalidation) reste réelle.
vi.mock("./api", async (importActual) => {
  const actual = await importActual<typeof import("./api")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedFetch = vi.mocked(apiFetch);

afterEach(() => {
  mockedFetch.mockReset();
});

function seed(): { client: QueryClient; initial: Folder[] } {
  const client = new QueryClient();
  const initial: Folder[] = [
    { id: "a", name: "Alpha", rank: "a0" },
    { id: "b", name: "Bravo", rank: "a1" },
    { id: "c", name: "Charlie", rank: "a2" },
  ];
  client.setQueryData<Folder[]>(FOLDERS_LIST_KEY, initial);
  return { client, initial };
}

function ranks(client: QueryClient): { id: string; rank: string }[] {
  return (client.getQueryData<Folder[]>(FOLDERS_LIST_KEY) ?? []).map((f) => ({
    id: f.id,
    rank: f.rank,
  }));
}

describe("reorderFolderMutationOptions (#109)", () => {
  it("PATCH /folders/:id {rank} (le serveur écrit le rang verbatim)", async () => {
    mockedFetch.mockResolvedValueOnce({ id: "a", name: "Alpha", rank: "a1V" });
    const { client } = seed();
    const opts = reorderFolderMutationOptions(client);

    await opts.mutationFn({ id: "a", rank: "a1V" });
    expect(mockedFetch).toHaveBeenCalledWith("/folders/a", {
      method: "PATCH",
      body: JSON.stringify({ rank: "a1V" }),
    });
  });

  it("onMutate : réécrit le rang et re-trie la liste optimistement", async () => {
    const { client } = seed();
    const opts = reorderFolderMutationOptions(client);

    // Déplace "a" après "b" (rang intercalé entre a1 et a2).
    await opts.onMutate({ id: "a", rank: "a1V" });

    // La liste est re-triée par rang : Bravo, Alpha, Charlie.
    expect(ranks(client).map((f) => f.id)).toEqual(["b", "a", "c"]);
    expect(ranks(client).find((f) => f.id === "a")?.rank).toBe("a1V");
  });

  it("onError : restaure uniquement le rang du folder concerné et re-trie", async () => {
    const { client } = seed();
    const opts = reorderFolderMutationOptions(client);

    const context = await opts.onMutate({ id: "a", rank: "a1V" });
    expect(ranks(client).map((f) => f.id)).toEqual(["b", "a", "c"]);

    opts.onError(new Error("boom"), { id: "a", rank: "a1V" }, context);

    // Retour à l'ordre initial trié par rang.
    expect(ranks(client)).toEqual([
      { id: "a", rank: "a0" },
      { id: "b", rank: "a1" },
      { id: "c", rank: "a2" },
    ]);
  });

  it("onSettled : invalide la liste des folders", () => {
    const client = new QueryClient();
    const invalidateQueries = vi.spyOn(client, "invalidateQueries");
    const opts = reorderFolderMutationOptions(client);

    opts.onSettled();
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: FOLDERS_LIST_KEY,
    });
  });
});
