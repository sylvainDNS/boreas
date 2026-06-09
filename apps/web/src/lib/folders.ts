import type { QueryClient } from "@tanstack/react-query";
import { queryOptions } from "@tanstack/react-query";
import { apiFetch } from "./api";
import {
  ARTICLES_COUNTS_KEY,
  ARTICLES_LIST_KEY,
  POLL_INTERVAL_MS,
} from "./articles";
import { FEEDS_LIST_KEY } from "./feeds";

/** Folder côté SPA (#13) : regroupement plat de Feeds. */
export interface Folder {
  id: string;
  name: string;
}

interface FoldersResponse {
  folders: Folder[];
}

/** Clé du cache de la liste des folders. */
export const FOLDERS_LIST_KEY = ["folders", "list"] as const;

/**
 * Query de la liste des folders (`GET /api/folders`, #13). Polle au même rythme
 * que feeds/articles : un folder créé sur un autre onglet remonte sans action.
 */
export function foldersQueryOptions() {
  return queryOptions({
    queryKey: FOLDERS_LIST_KEY,
    queryFn: async () => (await apiFetch<FoldersResponse>("/folders")).folders,
    refetchInterval: POLL_INTERVAL_MS,
  });
}

/** Création d'un Folder (`POST /api/folders`). Invalide la liste des folders. */
export function createFolderMutationOptions(queryClient: QueryClient) {
  return {
    mutationFn: (name: string) =>
      apiFetch<{ folder: Folder }>("/folders", {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: FOLDERS_LIST_KEY });
    },
  };
}

/** Renommage d'un Folder (`PATCH /api/folders/:id`). */
export function renameFolderMutationOptions(queryClient: QueryClient) {
  return {
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      apiFetch<{ id: string; name: string }>(`/folders/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: FOLDERS_LIST_KEY });
    },
  };
}

/**
 * Suppression d'un Folder (`DELETE /api/folders/:id`). Le serveur désassigne ses
 * Feeds (ils repassent « non classés ») : on invalide donc aussi feeds et
 * compteurs pour que la sidebar reflète le nouveau classement.
 */
export function deleteFolderMutationOptions(queryClient: QueryClient) {
  return {
    mutationFn: (id: string) =>
      apiFetch<{ ok: true }>(`/folders/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: FOLDERS_LIST_KEY });
      void queryClient.invalidateQueries({ queryKey: FEEDS_LIST_KEY });
      void queryClient.invalidateQueries({ queryKey: ARTICLES_COUNTS_KEY });
      void queryClient.invalidateQueries({ queryKey: ARTICLES_LIST_KEY });
    },
  };
}
