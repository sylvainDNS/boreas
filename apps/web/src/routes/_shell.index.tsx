import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { ArticleListView } from "../components/ArticleListView";
import {
  articleCountsQueryOptions,
  listArticlesInfiniteQueryOptions,
  markAllReadMutationOptions,
  toArticle,
  toggleArticleReadMutationOptions,
  toggleArticleSavedMutationOptions,
} from "../lib/articles";

/** Vue d'accueil « Tous les non-lus » (PRD US #18), alimentée par l'API (#6/#8). */
export const Route = createFileRoute("/_shell/")({
  component: UnreadView,
});

function UnreadView() {
  const queryClient = useQueryClient();
  // Les lus sont affichés par défaut (#8) ; l'interrupteur bascule sur unread.
  const [showRead, setShowRead] = useState(true);
  const query = useInfiniteQuery(
    listArticlesInfiniteQueryOptions(showRead ? "all" : "unread"),
  );
  const counts = useQuery(articleCountsQueryOptions());

  const toggleRead = useMutation(toggleArticleReadMutationOptions(queryClient));
  const toggleSaved = useMutation(
    toggleArticleSavedMutationOptions(queryClient),
  );
  const markAllRead = useMutation(markAllReadMutationOptions(queryClient));

  // Mémoïsé : la liste n'est recalculée que lorsque de nouvelles pages arrivent,
  // pas à chaque rendu (sélection d'article, etc.).
  const articles = useMemo(
    () =>
      query.data?.pages.flatMap((page) => page.articles.map(toArticle)) ?? [],
    [query.data],
  );

  // Stable entre rendus (`fetchNextPage` l'est dans React Query) : évite que
  // l'IntersectionObserver du scroll infini soit recréé à chaque rendu.
  const fetchNextPage = query.fetchNextPage;
  const onEndReached = useCallback(() => {
    void fetchNextPage();
  }, [fetchNextPage]);

  const onToggleRead = useCallback(
    (id: string, read: boolean) => toggleRead.mutate({ id, read }),
    [toggleRead],
  );
  const onToggleSaved = useCallback(
    (id: string, saved: boolean) => toggleSaved.mutate({ id, saved }),
    [toggleSaved],
  );
  const onMarkAllRead = useCallback(
    () => markAllRead.mutate({ scope: "global" }),
    [markAllRead],
  );

  return (
    <ArticleListView
      title="Tous les non-lus"
      articles={articles}
      emptyLabel={showRead ? "Aucun article à afficher." : "Tout est lu 🎉"}
      unreadCount={counts.data?.total}
      isLoading={query.isLoading}
      isError={query.isError}
      hasNextPage={query.hasNextPage}
      isFetchingNextPage={query.isFetchingNextPage}
      onEndReached={onEndReached}
      showRead={showRead}
      onToggleShowRead={() => setShowRead((v) => !v)}
      onToggleRead={onToggleRead}
      onToggleSaved={onToggleSaved}
      onMarkAllRead={onMarkAllRead}
    />
  );
}
