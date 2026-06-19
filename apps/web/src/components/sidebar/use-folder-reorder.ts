import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { reorderFolderMutationOptions } from "../../lib/folders";

/**
 * Réordonnancement des Folders par glisser-déposer (#109). Hook **dédié**
 * (distinct de `useFeedLifecycle`, qui ne porte que les ops Feed) exposant
 * `reorder(id, rank)` et `isReordering`. La mutation sous-jacente est optimiste
 * (`reorderFolderMutationOptions`) : le réordonnancement apparaît immédiatement
 * dans la sidebar. **Online-only** (ADR 0018) — la garde réseau est posée par
 * l'appelant (`Sidebar`/`FolderTree`).
 */
export function useFolderReorder() {
  const queryClient = useQueryClient();
  const reorderFolder = useMutation(reorderFolderMutationOptions(queryClient));

  const reorder = useCallback(
    (id: string, rank: string) => reorderFolder.mutate({ id, rank }),
    [reorderFolder],
  );

  return { reorder, isReordering: reorderFolder.isPending };
}

/** Valeur de retour de `useFolderReorder`. */
export type FolderReorder = ReturnType<typeof useFolderReorder>;
