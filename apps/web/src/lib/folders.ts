import type {
  Folder,
  FolderCreatedResponse,
  FolderRenamedResponse,
  FoldersResponse,
  OkResponse,
} from "@boreas/api-contracts";
import type { QueryClient } from "@tanstack/react-query";
import { queryOptions } from "@tanstack/react-query";
import { apiFetch } from "./api";
import {
  ARTICLES_COUNTS_KEY,
  ARTICLES_LIST_KEY,
  POLL_INTERVAL_MS,
} from "./articles";
import { FEEDS_LIST_KEY } from "./feeds";

/** Folder côté SPA (#13) : regroupement plat de Feeds. Contrat wire partagé. */
export type { Folder };

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
      apiFetch<FolderCreatedResponse>("/folders", {
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
      apiFetch<FolderRenamedResponse>(`/folders/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: FOLDERS_LIST_KEY });
    },
  };
}

/** Champs d'un réordonnancement de Folder (#109) : id ciblé + nouveau rang. */
export interface ReorderFolderInput {
  id: string;
  /** Rang fractionnaire calculé côté client (`rankBetween` des voisins, ADR 0020). */
  rank: string;
}

/**
 * Trie une liste de Folders par rang fractionnaire, `id` en départage (même
 * ordre total déterministe que `GET /api/folders`, ADR 0020). Pur, hors React.
 */
function sortFoldersByRank(list: readonly Folder[]): Folder[] {
  return [...list].sort(
    (a, b) => a.rank.localeCompare(b.rank) || a.id.localeCompare(b.id),
  );
}

/**
 * Réécrit le rang du Folder `id` dans le cache `FOLDERS_LIST_KEY` et **re-trie**
 * la liste (ordre canonique par rang). Partagé par l'écriture optimiste
 * (`onMutate`) et le rollback (`onError`) du réordonnancement, garantissant que
 * le rollback inverse exactement l'écriture (même chemin, pas de divergence).
 */
function setFolderRank(
  queryClient: QueryClient,
  id: string,
  rank: string,
): void {
  queryClient.setQueryData<Folder[]>(FOLDERS_LIST_KEY, (folders) =>
    folders
      ? sortFoldersByRank(
          folders.map((folder) =>
            folder.id === id ? { ...folder, rank } : folder,
          ),
        )
      : folders,
  );
}

/**
 * Mutation de **réordonnancement** d'un Folder (`PATCH /api/folders/:id {rank}`,
 * #109). **Optimiste** (calquée sur `updateFeedMutationOptions`) : `onMutate`
 * annule les requêtes en vol, capture le rang précédent du folder ciblé puis
 * réécrit son rang dans le cache `FOLDERS_LIST_KEY` **et re-trie** la liste pour
 * que la sidebar reflète le nouvel ordre sans attendre l'aller-retour. `onError`
 * restaure **uniquement le rang du folder concerné** (pas un instantané global),
 * afin qu'un rollback n'écrase pas un réordonnancement concurrent. `onSettled`
 * invalide la liste pour réconcilier. Ne touche pas aux compteurs (l'ordre
 * n'affecte pas les non-lus). **Online-only** (ADR 0018, ADR 0020).
 */
export function reorderFolderMutationOptions(queryClient: QueryClient) {
  return {
    mutationFn: ({ id, rank }: ReorderFolderInput) =>
      apiFetch<FolderRenamedResponse>(`/folders/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ rank }),
      }),
    onMutate: async ({
      id,
      rank,
    }: ReorderFolderInput): Promise<{
      rollback?: { id: string; rank: string };
    }> => {
      await queryClient.cancelQueries({ queryKey: FOLDERS_LIST_KEY });
      const previous = queryClient
        .getQueryData<Folder[]>(FOLDERS_LIST_KEY)
        ?.find((folder) => folder.id === id);
      if (!previous) return {};
      setFolderRank(queryClient, id, rank);
      return { rollback: { id, rank: previous.rank } };
    },
    onError: (
      _error: unknown,
      _vars: ReorderFolderInput,
      context: { rollback?: { id: string; rank: string } } | undefined,
    ) => {
      const rollback = context?.rollback;
      if (!rollback) return;
      setFolderRank(queryClient, rollback.id, rollback.rank);
    },
    onSettled: () => {
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
      apiFetch<OkResponse>(`/folders/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: FOLDERS_LIST_KEY });
      void queryClient.invalidateQueries({ queryKey: FEEDS_LIST_KEY });
      void queryClient.invalidateQueries({ queryKey: ARTICLES_COUNTS_KEY });
      void queryClient.invalidateQueries({ queryKey: ARTICLES_LIST_KEY });
    },
  };
}
