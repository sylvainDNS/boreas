import {
  infiniteQueryOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { apiFetch } from "./api";
import { formatRelativeTime } from "./time";

/**
 * Modèle de vue d'un Article côté SPA. Type canonique partagé par la liste et
 * le lecteur (les données mock des autres vues s'y conforment aussi).
 */
export interface Article {
  id: string;
  /** Identifiant du Feed source (jointure stable, contrairement au nom). */
  feedId: string;
  feedName: string;
  title: string;
  excerpt: string;
  time: string;
  /** URL de l'article original (pour « ouvrir l'original »), ou null. */
  link: string | null;
  unread: boolean;
  saved: boolean;
}

/** Forme renvoyée par `GET /api/articles`. */
interface ArticleDto {
  id: string;
  feedId: string;
  feedName: string;
  title: string | null;
  summary: string | null;
  link: string | null;
  publishedAt: string | null;
  read: boolean;
}

interface ArticlesPage {
  articles: ArticleDto[];
  nextCursor: string | null;
}

/** Convertit le DTO API en modèle de vue (libellé relatif, état non-lu). */
export function toArticle(dto: ArticleDto): Article {
  return {
    id: dto.id,
    feedId: dto.feedId,
    feedName: dto.feedName,
    title: dto.title ?? "(sans titre)",
    excerpt: dto.summary ?? "",
    time: formatRelativeTime(dto.publishedAt),
    link: dto.link,
    unread: !dto.read,
    saved: false, // l'état Saved arrive en #9
  };
}

/** Forme renvoyée par `GET /api/articles/:id` (contenu plein du lecteur). */
export interface ArticleDetail {
  id: string;
  feedName: string;
  title: string | null;
  link: string | null;
  publishedAt: string | null;
  /** HTML extrait + sanitizé côté serveur (ADR 0007), ou null si indisponible. */
  content: string | null;
}

/**
 * Query du contenu plein d'un Article. Le serveur **marque l'Article Read** au
 * GET (#7) : à la réussite, le lecteur retire l'état non-lu du cache de la liste.
 */
export function articleDetailQueryOptions(id: string) {
  return queryOptions({
    queryKey: ["articles", "detail", id],
    queryFn: () => apiFetch<ArticleDetail>(`/articles/${id}`),
  });
}

/** Filtre de la liste : non-lus seuls, ou lus + non-lus (#8, US 20). */
export type ArticleFilter = "all" | "unread";

/** Préfixe de clé commun à toutes les listes paginées (tous filtres confondus). */
export const ARTICLES_LIST_KEY = ["articles", "list"] as const;

/** Clé du cache des compteurs de non-lus exacts. */
export const ARTICLES_COUNTS_KEY = ["articles", "counts"] as const;

/**
 * Query infinie de la liste : pagination keyset par `cursor`, du plus récent au
 * plus ancien. La clé inclut le `filter` pour que « afficher / masquer les lus »
 * conserve deux caches distincts. Le scroll infini déclenche `fetchNextPage`.
 */
export function listArticlesInfiniteQueryOptions(filter: ArticleFilter) {
  return infiniteQueryOptions({
    queryKey: [...ARTICLES_LIST_KEY, filter],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ filter });
      if (pageParam) params.set("cursor", pageParam);
      return apiFetch<ArticlesPage>(`/articles?${params.toString()}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/** Compteurs de non-lus exacts : total global + agrégat par Feed (#8). */
export interface ArticleCounts {
  total: number;
  byFeed: { feedId: string; count: number }[];
}

export function articleCountsQueryOptions() {
  return queryOptions({
    queryKey: ARTICLES_COUNTS_KEY,
    queryFn: () => apiFetch<ArticleCounts>("/articles/counts"),
  });
}

/**
 * Pose l'état Read d'un Article dans **toutes** les listes en cache (tous
 * filtres) : le point non-lu disparaît/réapparaît et le titre se grise, mais
 * l'article **reste visible** (CONTEXT.md : un Read n'est pas retiré du flux).
 * Utilisé par le lecteur à l'ouverture (#7) et par la bascule manuelle (#8).
 */
export function setArticleReadInListCaches(
  queryClient: QueryClient,
  id: string,
  read: boolean,
): void {
  queryClient.setQueriesData<{ pages: ArticlesPage[]; pageParams: unknown[] }>(
    { queryKey: ARTICLES_LIST_KEY },
    (prev) =>
      prev
        ? {
            ...prev,
            pages: prev.pages.map((page) => ({
              ...page,
              articles: page.articles.map((a) =>
                a.id === id ? { ...a, read } : a,
              ),
            })),
          }
        : prev,
  );
}

/** Portée de « Tout marquer lu » (#8). Folder différé à #13. */
export type MarkReadScope =
  | { scope: "global" }
  | { scope: "feed"; feedId: string };

/**
 * Options de mutation pour la bascule manuelle Read↔non-lu (`PATCH /articles/:id`).
 * Mise à jour optimiste des listes en cache, puis ré-alignement des compteurs.
 */
export function toggleArticleReadMutationOptions(queryClient: QueryClient) {
  return {
    mutationFn: ({ id, read }: { id: string; read: boolean }) =>
      apiFetch<{ id: string; read: boolean }>(`/articles/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ read }),
      }),
    onMutate: async ({ id, read }: { id: string; read: boolean }) => {
      // Fige les refetch en vol, puis snapshot des listes pour pouvoir annuler.
      await queryClient.cancelQueries({ queryKey: ARTICLES_LIST_KEY });
      const previous = queryClient.getQueriesData({
        queryKey: ARTICLES_LIST_KEY,
      });
      setArticleReadInListCaches(queryClient, id, read);
      return { previous };
    },
    onError: (
      _err: unknown,
      _vars: { id: string; read: boolean },
      context: { previous: [readonly unknown[], unknown][] } | undefined,
    ) => {
      // Le serveur n'a rien changé : on restaure les listes d'avant la bascule.
      for (const [key, data] of context?.previous ?? []) {
        queryClient.setQueryData(key, data);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ARTICLES_COUNTS_KEY });
    },
  };
}

/**
 * Options de mutation pour « Tout marquer lu » (`POST /articles/mark-read`).
 * Changement de masse → on invalide listes et compteurs plutôt que de patcher.
 */
export function markAllReadMutationOptions(queryClient: QueryClient) {
  return {
    mutationFn: (scope: MarkReadScope) =>
      apiFetch<{ updated: number }>("/articles/mark-read", {
        method: "POST",
        body: JSON.stringify(scope),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ARTICLES_LIST_KEY });
      void queryClient.invalidateQueries({ queryKey: ARTICLES_COUNTS_KEY });
    },
  };
}
