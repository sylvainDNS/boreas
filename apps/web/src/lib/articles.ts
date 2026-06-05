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
  saved: boolean;
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
    saved: dto.saved,
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

/**
 * Filtre de la liste : non-lus seuls, lus + non-lus (#8, US 20), ou Saved
 * seuls (#9, vue Saved).
 */
export type ArticleFilter = "all" | "unread" | "saved";

/** Préfixe de clé commun à toutes les listes paginées (tous filtres confondus). */
export const ARTICLES_LIST_KEY = ["articles", "list"] as const;

/** Clé du cache des compteurs de non-lus exacts. */
export const ARTICLES_COUNTS_KEY = ["articles", "counts"] as const;

/**
 * Intervalle de poll des listes/compteurs (#10). En complément du refetch au
 * focus (déjà actif, `main.tsx`), il fait remonter les articles ingérés en
 * arrière-plan par le Cron/Queue sans action de l'utilisateur.
 */
const POLL_INTERVAL_MS = 60_000;

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
    refetchInterval: POLL_INTERVAL_MS,
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
    refetchInterval: POLL_INTERVAL_MS,
  });
}

/**
 * Options de mutation du Refresh manuel global (`POST /refresh`). Le serveur
 * **enqueue** un message par Feed (ingestion async via Cron/Queue, ADR 0002),
 * puis on invalide listes + compteurs : conjuguée au poll, l'invalidation fait
 * apparaître les nouveaux articles dès que la Queue les a ingérés (#10).
 */
export function refreshMutationOptions(queryClient: QueryClient) {
  return {
    mutationFn: () =>
      apiFetch<{ enqueued: number }>("/refresh", { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ARTICLES_LIST_KEY });
      void queryClient.invalidateQueries({ queryKey: ARTICLES_COUNTS_KEY });
    },
  };
}

/**
 * Réécrit, immutablement et en place, les articles de toutes les pages des
 * caches de liste désignés par `queryKey` (préfixe `ARTICLES_LIST_KEY` pour
 * tous les filtres, ou clé filtrée précise). Base commune aux mises à jour
 * optimistes des listes paginées (toggle Read/#8, Saved/#9, retrait de vue…).
 */
function mapArticlesInListCaches(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  mapArticles: (articles: ArticleDto[]) => ArticleDto[],
): void {
  queryClient.setQueriesData<{ pages: ArticlesPage[]; pageParams: unknown[] }>(
    { queryKey },
    (prev) =>
      prev
        ? {
            ...prev,
            pages: prev.pages.map((page) => ({
              ...page,
              articles: mapArticles(page.articles),
            })),
          }
        : prev,
  );
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
  mapArticlesInListCaches(queryClient, ARTICLES_LIST_KEY, (articles) =>
    articles.map((a) => (a.id === id ? { ...a, read } : a)),
  );
}

/**
 * Pose l'état Saved d'un Article dans **toutes** les listes en cache (tous
 * filtres) : l'étoile se remplit/se vide partout où l'article est visible.
 * La vue Saved gère en plus le retrait de l'article désauvé (voir la mutation).
 */
export function setArticleSavedInListCaches(
  queryClient: QueryClient,
  id: string,
  saved: boolean,
): void {
  mapArticlesInListCaches(queryClient, ARTICLES_LIST_KEY, (articles) =>
    articles.map((a) => (a.id === id ? { ...a, saved } : a)),
  );
}

/**
 * Retire un Article du cache de la **vue Saved** uniquement (`filter=saved`).
 * Appelé quand on désauve : un article non-Saved n'a plus sa place dans cette
 * vue, alors qu'il reste visible (étoile vide) dans « Tous les non-lus ».
 */
function removeArticleFromSavedCache(
  queryClient: QueryClient,
  id: string,
): void {
  mapArticlesInListCaches(
    queryClient,
    [...ARTICLES_LIST_KEY, "saved"],
    (articles) => articles.filter((a) => a.id !== id),
  );
}

/**
 * Options de mutation pour la bascule Saved↔non-Saved (`PATCH /articles/:id`).
 * Mise à jour optimiste : flip de l'étoile dans toutes les listes, et retrait
 * de la vue Saved quand on désauve. `onSettled` réconcilie ensuite la vue Saved
 * avec le serveur : un article sauvé ailleurs (cache Saved jamais alimenté par
 * le flip) y devient visible, et un désauvage échoué y réapparaît.
 */
export function toggleArticleSavedMutationOptions(queryClient: QueryClient) {
  return {
    mutationFn: ({ id, saved }: { id: string; saved: boolean }) =>
      apiFetch<{ id: string; saved: boolean }>(`/articles/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ saved }),
      }),
    onMutate: async ({ id, saved }: { id: string; saved: boolean }) => {
      await queryClient.cancelQueries({ queryKey: ARTICLES_LIST_KEY });
      const previous = queryClient.getQueriesData({
        queryKey: ARTICLES_LIST_KEY,
      });
      setArticleSavedInListCaches(queryClient, id, saved);
      if (!saved) removeArticleFromSavedCache(queryClient, id);
      return { previous };
    },
    onError: (
      _err: unknown,
      _vars: { id: string; saved: boolean },
      context: { previous: [readonly unknown[], unknown][] } | undefined,
    ) => {
      // Le serveur n'a rien changé : on restaure les listes d'avant la bascule.
      for (const [key, data] of context?.previous ?? []) {
        queryClient.setQueryData(key, data);
      }
    },
    onSettled: () => {
      // La vue Saved n'est pas reconstructible par le seul flip optimiste (un
      // article sauvé ailleurs n'y est jamais inséré) : on la ré-aligne sur le
      // serveur. Les autres filtres restent gérés par la MAJ optimiste.
      void queryClient.invalidateQueries({
        queryKey: [...ARTICLES_LIST_KEY, "saved"],
      });
    },
  };
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
