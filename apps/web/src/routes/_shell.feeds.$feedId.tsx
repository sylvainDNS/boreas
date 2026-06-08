import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { ArticleListView } from "../components/ArticleListView";
import {
  listArticlesInfiniteQueryOptions,
  markAllReadMutationOptions,
  toArticle,
  toggleArticleReadMutationOptions,
  toggleArticleSavedMutationOptions,
} from "../lib/articles";
import { feedLabel, feedsQueryOptions } from "../lib/feeds";

/** Vue filtrée par Feed (PRD US #19), alimentée par l'API (#11). */
export const Route = createFileRoute("/_shell/feeds/$feedId")({
  component: FeedView,
});

function FeedView() {
  const { feedId } = Route.useParams();
  const queryClient = useQueryClient();

  // Liste des articles du feed (lus + non-lus), scope serveur via `feedId`.
  const query = useInfiniteQuery(
    listArticlesInfiniteQueryOptions("all", feedId),
  );
  const feeds = useQuery(feedsQueryOptions());
  const feed = feeds.data?.find((f) => f.id === feedId);
  // Feed inexistant (lien périmé, feed supprimé) : la liste est chargée mais ne
  // contient pas ce feedId. On le distingue d'un feed sain mais vide.
  const notFound = feeds.isSuccess && !feed;

  const toggleRead = useMutation(toggleArticleReadMutationOptions(queryClient));
  const toggleSaved = useMutation(
    toggleArticleSavedMutationOptions(queryClient),
  );
  const markAllRead = useMutation(markAllReadMutationOptions(queryClient));

  const articles = useMemo(
    () =>
      query.data?.pages.flatMap((page) => page.articles.map(toArticle)) ?? [],
    [query.data],
  );

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
    () => markAllRead.mutate({ scope: "feed", feedId }),
    [markAllRead, feedId],
  );

  return (
    <ArticleListView
      title={notFound ? "Flux introuvable" : feed ? feedLabel(feed) : "Flux"}
      articles={articles}
      emptyLabel={
        notFound
          ? "Ce flux n'existe pas ou plus."
          : "Aucun article récent pour ce flux."
      }
      isLoading={query.isLoading}
      isError={query.isError}
      hasNextPage={query.hasNextPage}
      isFetchingNextPage={query.isFetchingNextPage}
      onEndReached={onEndReached}
      onToggleRead={onToggleRead}
      onToggleSaved={onToggleSaved}
      onMarkAllRead={onMarkAllRead}
    />
  );
}
