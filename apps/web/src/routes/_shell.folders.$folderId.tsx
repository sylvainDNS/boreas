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
  articleCountsQueryOptions,
  listArticlesInfiniteQueryOptions,
  markAllReadMutationOptions,
  toArticle,
  toggleArticleReadMutationOptions,
  toggleArticleSavedMutationOptions,
} from "../lib/articles";
import { foldersQueryOptions } from "../lib/folders";

/** Vue agrégée d'un Folder : articles de tous ses Feeds (PRD US #17, #13). */
export const Route = createFileRoute("/_shell/folders/$folderId")({
  component: FolderView,
});

function FolderView() {
  const { folderId } = Route.useParams();
  const queryClient = useQueryClient();

  // Articles de tous les Feeds du folder (lus + non-lus), scope serveur `folderId`.
  const query = useInfiniteQuery(
    listArticlesInfiniteQueryOptions("all", undefined, folderId),
  );
  const folders = useQuery(foldersQueryOptions());
  const folder = folders.data?.find((f) => f.id === folderId);
  // Folder inexistant (lien périmé, folder supprimé) : la liste est chargée mais
  // ne contient pas cet id. On le distingue d'un folder sain mais vide.
  const notFound = folders.isSuccess && !folder;
  // Non-lus exacts du folder (badge), depuis l'agrégat serveur.
  const counts = useQuery(articleCountsQueryOptions());
  const unreadCount = counts.data?.byFolder.find(
    (f) => f.folderId === folderId,
  )?.count;

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
    () => markAllRead.mutate({ scope: "folder", folderId }),
    [markAllRead, folderId],
  );

  return (
    <ArticleListView
      title={notFound ? "Dossier introuvable" : (folder?.name ?? "Dossier")}
      articles={articles}
      unreadCount={unreadCount}
      emptyLabel={
        notFound
          ? "Ce dossier n'existe pas ou plus."
          : "Aucun article dans ce dossier."
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
