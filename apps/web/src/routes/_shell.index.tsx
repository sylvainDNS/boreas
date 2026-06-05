import { useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ArticleListView } from "../components/ArticleListView";
import { toArticle, unreadArticlesInfiniteQueryOptions } from "../lib/articles";

/** Vue d'accueil « Tous les non-lus » (PRD US #18), alimentée par l'API (#6). */
export const Route = createFileRoute("/_shell/")({
  component: UnreadView,
});

function UnreadView() {
  const query = useInfiniteQuery(unreadArticlesInfiniteQueryOptions());
  const articles =
    query.data?.pages.flatMap((page) => page.articles.map(toArticle)) ?? [];

  return (
    <ArticleListView
      title="Tous les non-lus"
      articles={articles}
      emptyLabel="Tout est lu 🎉"
      isLoading={query.isLoading}
      isError={query.isError}
      hasNextPage={query.hasNextPage}
      isFetchingNextPage={query.isFetchingNextPage}
      onEndReached={() => {
        void query.fetchNextPage();
      }}
    />
  );
}
