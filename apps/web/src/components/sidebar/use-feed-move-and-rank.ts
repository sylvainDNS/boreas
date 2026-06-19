import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { moveAndRankFeedMutationOptions } from "../../lib/feeds";

/**
 * Déplacement **inter-conteneur à position précise** d'un Feed par glisser-déposer
 * (#112) : pose un Feed dans un autre conteneur à une position donnée en un seul
 * PATCH `{folderId, rank}` atomique. Hook **dédié** (distinct de `useFeedReorder`,
 * réordonnancement intra-conteneur #111, et de `useFeedLifecycle.move`, déplacement
 * sans position #13) exposant `moveAndRank(id, folderId, rank)` et `isMoving`. La
 * mutation sous-jacente est optimiste (`moveAndRankFeedMutationOptions`) : le
 * déplacement et le positionnement apparaissent immédiatement dans la sidebar.
 * **Online-only** (ADR 0018) — la garde réseau est posée par l'appelant (`Sidebar`).
 */
export function useFeedMoveAndRank() {
  const queryClient = useQueryClient();
  const moveAndRankFeed = useMutation(
    moveAndRankFeedMutationOptions(queryClient),
  );

  const moveAndRank = useCallback(
    (id: string, folderId: string | null, rank: string) =>
      moveAndRankFeed.mutate({ id, folderId, rank }),
    [moveAndRankFeed],
  );

  return { moveAndRank, isMoving: moveAndRankFeed.isPending };
}

/** Valeur de retour de `useFeedMoveAndRank`. */
export type FeedMoveAndRank = ReturnType<typeof useFeedMoveAndRank>;
