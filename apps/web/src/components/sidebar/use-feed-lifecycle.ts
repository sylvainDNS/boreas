import type {
  FeedUnsubscribedResponse,
  OkResponse,
} from "@boreas/api-contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMatchRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback } from "react";
import { apiFetch } from "../../lib/api";
import {
  type Feed,
  invalidateAfterFeedLifecycle,
  updateFeedMutationOptions,
} from "../../lib/feeds";

/**
 * Cycle de vie d'un Feed côté navigation (#48). **Seul module de la Sidebar
 * couplé au router** : il porte les mutations désabonnement/suppression/
 * déplacement et l'effet de navigation `leaveFeedIfActive` (après
 * désabonnement/suppression du feed actif, on retombe sur « Tous les
 * non-lus » plutôt que sur une vue vide). Les invalidations restent celles des
 * options de mutation de `lib/feeds.ts` (`invalidateAfterFeedLifecycle`).
 */
export function useFeedLifecycle() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const matchRoute = useMatchRoute();
  const router = useRouter();

  // Après désabonnement/suppression, le feed quitte la sidebar : si on était sur
  // sa page, on retombe sur « Tous les non-lus » plutôt que sur une vue vide.
  const leaveFeedIfActive = useCallback(
    (feedId: string) => {
      if (matchRoute({ to: "/feeds/$feedId", params: { feedId } })) {
        void navigate({ to: "/" });
      }
    },
    [matchRoute, navigate],
  );

  // Désabonnement/suppression keyés par `Feed` (et non `id`) : `leaveFeedIfActive`
  // s'enchaîne dans `onSuccess`, qui reçoit la variable de mutation. Mêmes appels
  // wire et invalidations que les options de `lib/feeds.ts`.
  const unsubscribe = useMutation({
    mutationFn: (feed: Feed) =>
      apiFetch<FeedUnsubscribedResponse>(`/feeds/${feed.id}/unsubscribe`, {
        method: "POST",
      }),
    onSuccess: (_data, feed) => {
      invalidateAfterFeedLifecycle(queryClient);
      leaveFeedIfActive(feed.id);
    },
  });

  const remove = useMutation({
    mutationFn: (feed: Feed) =>
      apiFetch<OkResponse>(`/feeds/${feed.id}`, { method: "DELETE" }),
    onSuccess: (_data, feed) => {
      invalidateAfterFeedLifecycle(queryClient);
      leaveFeedIfActive(feed.id);
    },
  });

  const updateFeed = useMutation(updateFeedMutationOptions(queryClient));
  const move = useCallback(
    (id: string, folderId: string | null) =>
      updateFeed.mutate({ id, folderId }),
    [updateFeed],
  );

  return {
    unsubscribe,
    remove,
    move,
    isMoving: updateFeed.isPending,
    router,
  };
}

/** Valeur de retour de `useFeedLifecycle` (mutations + déplacement + router). */
export type FeedLifecycle = ReturnType<typeof useFeedLifecycle>;
