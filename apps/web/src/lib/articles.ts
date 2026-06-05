import { infiniteQueryOptions } from "@tanstack/react-query";
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
    unread: !dto.read,
    saved: false, // l'état Saved arrive en #9
  };
}

export const UNREAD_ARTICLES_QUERY_KEY = ["articles", "unread"] as const;

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
