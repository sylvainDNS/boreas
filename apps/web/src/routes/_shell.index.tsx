import { useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { ArticleListView } from "../components/ArticleListView";
import { toArticle, unreadArticlesInfiniteQueryOptions } from "../lib/articles";

/** Vue d'accueil « Tous les non-lus » (PRD US #18), alimentée par l'API (#6). */
export const Route = createFileRoute("/_shell/")({
  component: UnreadView,
});

function UnreadView() {
  const query = useInfiniteQuery(unreadArticlesInfiniteQueryOptions());

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

  return (
    <ArticleListView
      title="Tous les non-lus"
      articles={articles}
      emptyLabel="Tout est lu 🎉"
      isLoading={query.isLoading}
      isError={query.isError}
      hasNextPage={query.hasNextPage}
      isFetchingNextPage={query.isFetchingNextPage}
      onEndReached={onEndReached}
    />
  );
}
