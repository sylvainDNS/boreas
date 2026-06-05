import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { ArticleListView } from "../components/ArticleListView";
import {
  listArticlesInfiniteQueryOptions,
  toArticle,
  toggleArticleSavedMutationOptions,
} from "../lib/articles";

/** Vue des articles Saved (PRD US #30), alimentée par l'API (#9). */
export const Route = createFileRoute("/_shell/saved")({
  component: SavedView,
});

function SavedView() {
  const queryClient = useQueryClient();
  const query = useInfiniteQuery(listArticlesInfiniteQueryOptions("saved"));
  const toggleSaved = useMutation(
    toggleArticleSavedMutationOptions(queryClient),
  );

  const articles = useMemo(
    () =>
      query.data?.pages.flatMap((page) => page.articles.map(toArticle)) ?? [],
    [query.data],
  );

  const fetchNextPage = query.fetchNextPage;
  const onEndReached = useCallback(() => {
    void fetchNextPage();
  }, [fetchNextPage]);

  const onToggleSaved = useCallback(
    (id: string, saved: boolean) => toggleSaved.mutate({ id, saved }),
    [toggleSaved],
  );

  return (
    <ArticleListView
      title="Saved"
      articles={articles}
      emptyLabel="Aucun article sauvegardé pour l'instant."
      isLoading={query.isLoading}
      isError={query.isError}
      hasNextPage={query.hasNextPage}
      isFetchingNextPage={query.isFetchingNextPage}
      onEndReached={onEndReached}
      onToggleSaved={onToggleSaved}
    />
  );
}
