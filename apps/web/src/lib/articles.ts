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

export const UNREAD_ARTICLES_QUERY_KEY = ["articles", "unread"] as const;

/**
 * Bascule un Article en lu dans le cache de la liste « non-lus » : le point
 * non-lu disparaît et le titre se grise, mais l'article **reste visible**
 * (CONTEXT.md : un Read n'est pas retiré du flux). Appelé après l'ouverture,
 * le serveur ayant déjà persisté le Read (#7).
 */
export function markArticleReadInListCache(
  queryClient: QueryClient,
  id: string,
): void {
  queryClient.setQueryData<{ pages: ArticlesPage[]; pageParams: unknown[] }>(
    UNREAD_ARTICLES_QUERY_KEY,
    (prev) =>
      prev
        ? {
            ...prev,
            pages: prev.pages.map((page) => ({
              ...page,
              articles: page.articles.map((a) =>
                a.id === id ? { ...a, read: true } : a,
              ),
            })),
          }
        : prev,
  );
}

/**
 * Query infinie « Tous les non-lus » : pagination keyset par `cursor`, du plus
 * récent au plus ancien. Le scroll infini déclenche `fetchNextPage`.
 */
export function unreadArticlesInfiniteQueryOptions() {
  return infiniteQueryOptions({
    queryKey: UNREAD_ARTICLES_QUERY_KEY,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ filter: "unread" });
      if (pageParam) params.set("cursor", pageParam);
      return apiFetch<ArticlesPage>(`/articles?${params.toString()}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}
