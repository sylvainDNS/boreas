import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import type { Article } from "./articles";
import {
  articleCountsQueryOptions,
  listArticlesInfiniteQueryOptions,
  markAllReadMutationOptions,
  refreshMutationOptions,
  toArticle,
  toggleArticleReadMutationOptions,
  toggleArticleSavedMutationOptions,
} from "./articles";
import { feedLabel, feedsQueryOptions } from "./feeds";
import { foldersQueryOptions } from "./folders";

/**
 * Portée d'une vue « liste d'articles » (#6/#11/#13/#9). Discriminée sur `kind`
 * pour porter le paramètre propre à chaque vue (Feed/Folder). Source unique des
 * différences entre les quatre routes qui montaient `ArticleListView`.
 */
export type ArticleScope =
  | { kind: "all" }
  | { kind: "feed"; feedId: string }
  | { kind: "folder"; folderId: string }
  | { kind: "saved" };

/**
 * Modèle de vue consommé tel quel par `ArticleListView` (#8/#9). Reprend à
 * l'identique les présences/absences de callbacks par scope qui existaient dans
 * les routes :
 *  - `showRead`/`onToggleShowRead`/`onRefresh`/`isRefreshing` : scope « all »
 *    uniquement (l'interrupteur lus + le refresh manuel y vivent) ;
 *  - `onToggleRead`/`onMarkAllRead` : absents en « saved » (pas de bascule lu ni
 *    de « tout marquer lu » sur les Saved) ;
 *  - `onToggleSaved` : présent partout (l'étoile est universelle).
 */
export interface ArticleView {
  /** Titre du panneau liste (libellé du feed/folder, ou titre figé). */
  title: string;
  /** Texte de l'état vide. */
  emptyLabel: string;
  /** Articles agrégés de toutes les pages chargées. */
  articles: Article[];
  /** Non-lus exacts (compteur API), si la vue en expose un. */
  unreadCount?: number;
  /** Chargement de la première page. */
  isLoading: boolean;
  /** Erreur de chargement de la liste. */
  isError: boolean;
  /** Reste-t-il des pages ? */
  hasNextPage: boolean;
  /** Une page suivante se charge. */
  isFetchingNextPage: boolean;
  /** Demande la page suivante (scroll infini). */
  onEndReached: () => void;
  /** Les lus sont-ils affichés ? (scope « all »). */
  showRead?: boolean;
  /** Bascule afficher/masquer les lus (scope « all »). */
  onToggleShowRead?: () => void;
  /** Bascule Read↔non-lu d'un article (absent en « saved »). */
  onToggleRead?: (id: string, read: boolean) => void;
  /** Bascule Saved↔non-Saved d'un article (#9). */
  onToggleSaved: (id: string, saved: boolean) => void;
  /** « Tout marquer comme lu » sur la portée (absent en « saved »). */
  onMarkAllRead?: () => void;
  /** Refresh manuel des flux (scope « all »). */
  onRefresh?: () => void;
  /** Un refresh est en cours (scope « all »). */
  isRefreshing?: boolean;
}

/**
 * Hook profond du data-fetching d'une vue d'articles. Encapsule le squelette
 * dupliqué par les quatre routes (`_shell.index`, `feeds.$feedId`,
 * `folders.$folderId`, `saved`) : liste infinie keyset, mutations Read/Saved/
 * « tout lu », compteurs, et — pour Feed/Folder — résolution du libellé et de
 * l'état « introuvable ».
 *
 * Les hooks sont **inconditionnels** (règle des Hooks) : les queries annexes
 * (feeds, folders, counts) sont toujours déclarées, activées par `enabled:`
 * selon le scope. On ne « factorise » pas en appels conditionnels.
 */
export function useArticleView(scope: ArticleScope): ArticleView {
  const queryClient = useQueryClient();

  // Interrupteur « afficher les lus » (#8) : utilisé par le seul scope « all »,
  // mais l'état est déclaré inconditionnellement (règle des Hooks).
  const [showRead, setShowRead] = useState(true);

  const filter =
    scope.kind === "all"
      ? showRead
        ? "all"
        : "unread"
      : scope.kind === "saved"
        ? "saved"
        : "all";
  const feedId = scope.kind === "feed" ? scope.feedId : undefined;
  const folderId = scope.kind === "folder" ? scope.folderId : undefined;

  const query = useInfiniteQuery(
    listArticlesInfiniteQueryOptions(filter, feedId, folderId),
  );

  // Queries annexes : toujours déclarées, activées selon le scope.
  const feeds = useQuery({
    ...feedsQueryOptions(),
    enabled: scope.kind === "feed",
  });
  const folders = useQuery({
    ...foldersQueryOptions(),
    enabled: scope.kind === "folder",
  });
  const counts = useQuery({
    ...articleCountsQueryOptions(),
    enabled: scope.kind === "all" || scope.kind === "folder",
  });

  const toggleRead = useMutation(toggleArticleReadMutationOptions(queryClient));
  const toggleSaved = useMutation(
    toggleArticleSavedMutationOptions(queryClient),
  );
  const markAllRead = useMutation(markAllReadMutationOptions(queryClient));
  const refresh = useMutation(refreshMutationOptions(queryClient));

  // Mémoïsé : la liste n'est recalculée qu'à l'arrivée de nouvelles pages.
  const articles = useMemo(
    () =>
      query.data?.pages.flatMap((page) => page.articles.map(toArticle)) ?? [],
    [query.data],
  );

  // Stable entre rendus (`fetchNextPage` l'est dans React Query) : évite de
  // recréer l'IntersectionObserver du scroll infini à chaque rendu.
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

  // Feed/Folder « introuvable » : la liste a chargé mais l'entité n'est pas dans
  // sa collection (lien périmé, suppression). Distinct d'une entité saine vide.
  const feed = feeds.data?.find((f) => f.id === feedId);
  const feedNotFound = scope.kind === "feed" && feeds.isSuccess && !feed;
  const folder = folders.data?.find((f) => f.id === folderId);
  const folderNotFound =
    scope.kind === "folder" && folders.isSuccess && !folder;

  const base = {
    articles,
    isLoading: query.isLoading,
    isError: query.isError,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    onEndReached,
    onToggleSaved,
  };

  switch (scope.kind) {
    case "all":
      return {
        ...base,
        title: "Tous les non-lus",
        emptyLabel: showRead ? "Aucun article à afficher." : "Tout est lu 🎉",
        unreadCount: counts.data?.total,
        showRead,
        onToggleShowRead: () => setShowRead((v) => !v),
        onToggleRead,
        onMarkAllRead: () => markAllRead.mutate({ scope: "global" }),
        onRefresh: () => refresh.mutate(),
        isRefreshing: refresh.isPending,
      };
    case "feed":
      return {
        ...base,
        title: feedNotFound
          ? "Flux introuvable"
          : feed
            ? feedLabel(feed)
            : "Flux",
        emptyLabel: feedNotFound
          ? "Ce flux n'existe pas ou plus."
          : "Aucun article récent pour ce flux.",
        onToggleRead,
        onMarkAllRead: () =>
          markAllRead.mutate({ scope: "feed", feedId: scope.feedId }),
      };
    case "folder":
      return {
        ...base,
        title: folderNotFound
          ? "Dossier introuvable"
          : (folder?.name ?? "Dossier"),
        emptyLabel: folderNotFound
          ? "Ce dossier n'existe pas ou plus."
          : "Aucun article dans ce dossier.",
        unreadCount: counts.data?.byFolder.find(
          (f) => f.folderId === scope.folderId,
        )?.count,
        onToggleRead,
        onMarkAllRead: () =>
          markAllRead.mutate({ scope: "folder", folderId: scope.folderId }),
      };
    case "saved":
      return {
        ...base,
        title: "Saved",
        emptyLabel: "Aucun article sauvegardé pour l'instant.",
      };
  }
}
