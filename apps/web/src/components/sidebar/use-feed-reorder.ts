import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { reorderFeedMutationOptions } from "../../lib/feeds";

/**
 * Réordonnancement des Feeds au sein de leur conteneur par glisser-déposer
 * (#111). Hook **dédié** (distinct de `useFeedLifecycle`, qui porte le
 * déplacement inter-conteneur #13, et de `useFolderReorder`, #109) exposant
 * `reorder(id, rank)` et `isReordering`. La mutation sous-jacente est optimiste
 * (`reorderFeedMutationOptions`) : le réordonnancement apparaît immédiatement
 * dans la sidebar. **Online-only** (ADR 0018) — la garde réseau est posée par
 * l'appelant (`Sidebar`).
 */
export function useFeedReorder() {
  const queryClient = useQueryClient();
  const reorderFeed = useMutation(reorderFeedMutationOptions(queryClient));

  const reorder = useCallback(
    (id: string, rank: string) => reorderFeed.mutate({ id, rank }),
    [reorderFeed],
  );

  return { reorder, isReordering: reorderFeed.isPending };
}

/** Valeur de retour de `useFeedReorder`. */
export type FeedReorder = ReturnType<typeof useFeedReorder>;
