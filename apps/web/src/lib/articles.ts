import type {
  ArticleCountsResponse,
  ArticleDetailResponse,
  ArticleFilter,
  ArticleListItem,
  ArticleListResponse,
  MarkReadRequest,
  RefreshResponse,
} from "@boreas/api-contracts";
import {
  infiniteQueryOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { apiFetch } from "./api";
import { readArticleDetail } from "./sync/article-detail-repository";
import { localArticleCounts, readArticlePage } from "./sync/article-repository";
import {
  enqueueOutbox,
  markReadInReplica,
  setArticleFieldInReplica,
} from "./sync/outbox-store";
import { getReplica, syncReplica } from "./sync/replica";
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

/** Convertit l'item wire en modèle de vue (libellé relatif, état non-lu). */
export function toArticle(dto: ArticleListItem): Article {
  return {
    id: dto.id,
    feedId: dto.feedId,
    feedName: dto.feedName,
    title: dto.title ?? "(sans titre)",
    excerpt: dto.summary ?? "",
    // Date d'affichage = publication, ou ingestion à défaut (ADR 0015) :
    // cohérent avec la clé de tri SQL `coalesce(published_at, fetched_at)`.
    time: formatRelativeTime(dto.publishedAt ?? dto.fetchedAt),
    link: dto.link,
    unread: !dto.read,
    saved: dto.saved,
  };
}

/** Forme renvoyée par `GET /api/articles/:id` (contenu plein du lecteur). */
export type ArticleDetail = ArticleDetailResponse;

/**
 * Query du contenu plein d'un Article — **local-first (#75, ADR 0018)**.
 *
 * Le `queryFn` lit d'abord le **réplica** (métadonnées) + le **store content**
 * (HTML pré-téléchargé par le moteur de sync, sans effet Read) : un article du
 * corpus offline (non-lus ∪ Saved) s'ouvre alors **hors-ligne sans l'avoir jamais
 * ouvert**. Faute de local suffisant (métadonnées absentes, ou contenu jamais
 * téléchargé — typiquement un deep-link hors corpus), on retombe sur l'**API**
 * (`GET /api/articles/:id`, qui ne marque plus Read depuis #75).
 *
 * Le marquage Read **à l'ouverture** n'est plus un effet de ce GET : c'est une
 * mutation client explicite déclenchée par `ReaderPane` (outbox, #74).
 */
export function articleDetailQueryOptions(id: string) {
  return queryOptions({
    queryKey: ["articles", "detail", id],
    queryFn: async () => {
      const local = await readArticleDetail(await getReplica(), id);
      if (local) return local;
      // Fallback réseau : article hors du corpus local (deep-link/refresh) ou
      // contenu pas encore synchronisé. Le GET ne marque plus Read (#75).
      return apiFetch<ArticleDetail>(`/articles/${id}`);
    },
  });
}

/**
 * Filtre de la liste : non-lus seuls, lus + non-lus (#8, US 20), ou Saved
 * seuls (#9, vue Saved). Contrat wire partagé (`@boreas/api-contracts`).
 */
export type { ArticleFilter };

/** Préfixe de clé commun à toutes les listes paginées (tous filtres confondus). */
export const ARTICLES_LIST_KEY = ["articles", "list"] as const;

/**
 * Clé de cache d'une liste paginée, **source de vérité unique** de sa forme
 * (`[...préfixe, filter, feedId, folderId]`). Utilisée par la query ET par
 * l'invalidation post-sync (`useReplicaSync`) : dériver les deux d'ici évite
 * qu'une invalidation cible une clé fantôme si la forme évolue (#73).
 */
export function articlesListQueryKey(
  filter: ArticleFilter,
  feedId?: string,
  folderId?: string,
) {
  return [...ARTICLES_LIST_KEY, filter, feedId ?? null, folderId ?? null];
}

/** Clé du cache des compteurs de non-lus exacts (calculés localement, #73). */
export const ARTICLES_COUNTS_KEY = ["articles", "counts"] as const;

/**
 * Préfixe de clé du cache de la **recherche locale** (#73). Invalidé aux mêmes
 * points que les listes pour que les résultats de recherche reflètent les
 * bascules Read/Saved et les nouveaux articles synchronisés (la recherche lit le
 * réplica, comme les listes). Défini ici — et non dans `use-search-view` — pour
 * que les mutations et le moteur de sync l'invalident sans import circulaire.
 */
export const SEARCH_QUERY_KEY = ["articles", "search"] as const;

/**
 * Intervalle de poll historique des listes/compteurs (#10). Conservé pour les
 * queries encore servies par l'API (feeds/folders, #11/#13). Les listes
 * d'articles et les compteurs sont désormais **local-first** (#73) : rafraîchis
 * par le moteur de sync (focus/online/intervalle), ils n'utilisent plus ce poll.
 */
export const POLL_INTERVAL_MS = 60_000;

/**
 * Query infinie de la liste : pagination keyset par `cursor`, du plus récent au
 * plus ancien. La clé inclut le `filter`, le `feedId` (vue par Feed, #11) et le
 * `folderId` (vue agrégée par Folder, #13) pour que chaque vue conserve un cache
 * distinct. `feedId` et `folderId` sont mutuellement exclusifs en pratique. Le
 * scroll infini déclenche `fetchNextPage`.
 *
 * **Frontière local-first (#73, ADR 0018)** : **toutes** les vues (all, unread,
 * saved, par Feed, par Folder) lisent désormais le **réplica local** via le
 * repository — l'UI ne fait plus aucun appel réseau direct pour les listes. Le
 * moteur de sync est seul à parler au backend (focus/online/intervalle), si bien
 * que ces vues n'ont plus besoin du poll 60 s : `refetchInterval` est coupé. Le
 * repository reproduit exactement le filtrage/tri/pagination de l'API.
 */
export function listArticlesInfiniteQueryOptions(
  filter: ArticleFilter,
  feedId?: string,
  folderId?: string,
) {
  return infiniteQueryOptions({
    queryKey: articlesListQueryKey(filter, feedId, folderId),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      // Lecture du réplica : forme `ArticleListResponse` identique à l'API,
      // pour que `useInfiniteQuery`/`toArticle` restent inchangés.
      readArticlePage(
        await getReplica(),
        { filter, feedId, folderId },
        pageParam,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // Vue rafraîchie par le moteur de sync (focus/online/intervalle), pas par le
    // poll de liste : on désactive `refetchInterval`.
    refetchInterval: false,
  });
}

/** Compteurs de non-lus exacts : total + agrégat par Feed (#8) et par Folder (#13). */
export type ArticleCounts = ArticleCountsResponse;

/**
 * Compteurs de non-lus **calculés localement** depuis le réplica (#73, ADR 0018).
 * Même forme `ArticleCounts` que l'ex-`GET /api/articles/counts` (consommateurs
 * `Sidebar`/`useArticleView` inchangés), mais exacts **hors-ligne** : plus aucun
 * appel à `/articles/counts` côté affichage. Rafraîchis par le moteur de sync et
 * les mutations optimistes (qui invalident `ARTICLES_COUNTS_KEY`).
 */
export function articleCountsQueryOptions() {
  return queryOptions({
    queryKey: ARTICLES_COUNTS_KEY,
    queryFn: async () => localArticleCounts(await getReplica()),
    refetchInterval: false,
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
    mutationFn: () => apiFetch<RefreshResponse>("/refresh", { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ARTICLES_LIST_KEY });
      void queryClient.invalidateQueries({ queryKey: ARTICLES_COUNTS_KEY });
      void queryClient.invalidateQueries({ queryKey: SEARCH_QUERY_KEY });
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
  mapArticles: (articles: ArticleListItem[]) => ArticleListItem[],
): void {
  queryClient.setQueriesData<{
    pages: ArticleListResponse[];
    pageParams: unknown[];
  }>({ queryKey }, (prev) =>
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
 * Pose l'état Saved dans le cache de la **query détail** (`?article`/deep-link).
 * Sans ça, l'étoile du lecteur d'un Article ouvert hors liste (où aucun cache de
 * liste ne porte l'article) resterait figée sur sa valeur d'origine après bascule.
 * No-op si le détail n'est pas en cache.
 */
function setArticleSavedInDetailCache(
  queryClient: QueryClient,
  id: string,
  saved: boolean,
): void {
  queryClient.setQueryData<ArticleDetail>(
    articleDetailQueryOptions(id).queryKey,
    (prev) => (prev ? { ...prev, saved } : prev),
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
 * Sync montante offline-safe (#74, ADR 0018). La mutation a déjà écrit le réplica
 * + le cache + empilé l'outbox dans `onMutate` ; le `mutationFn` ne fait que
 * **tenter** un flush best-effort vers l'API et **réussit toujours localement** —
 * un `apiFetch` qui rejette hors-ligne ne doit pas faire échouer l'UX. Le moteur
 * de sync (`runSync`) flushe l'outbox push-avant-pull ; on délègue donc à
 * `syncReplica()` (qui pousse l'outbox avant de pull) et on avale l'erreur réseau.
 * À la reconnexion (event `online`/focus), la passe de sync re-flushera l'outbox.
 */
async function flushBestEffort(): Promise<void> {
  try {
    await syncReplica();
  } catch {
    // Hors-ligne / 401 : l'entrée reste en outbox, re-flushée à la reconnexion.
  }
}

/**
 * Options de mutation pour la bascule Saved↔non-Saved.
 *
 * **Local-first (#74, ADR 0018)** : `onMutate` applique l'état optimistement au
 * **réplica** (source de la vue non-lus local-first), au **cache react-query**
 * (vues feed/folder/saved encore servies par l'API jusqu'à #73), puis **empile
 * l'outbox** (push à la reconnexion). Le `mutationFn` est offline-safe (flush
 * best-effort). `onSettled` réconcilie la vue Saved avec le serveur.
 */
export function toggleArticleSavedMutationOptions(queryClient: QueryClient) {
  return {
    mutationFn: async ({ saved: _saved }: { id: string; saved: boolean }) => {
      // Tout est déjà écrit localement (onMutate) ; on ne fait que pousser au
      // mieux. Ne rejette jamais hors-ligne (sinon onError annulerait l'optimisme).
      await flushBestEffort();
      return { ok: true } as const;
    },
    onMutate: async ({ id, saved }: { id: string; saved: boolean }) => {
      const detailKey = articleDetailQueryOptions(id).queryKey;
      await queryClient.cancelQueries({ queryKey: ARTICLES_LIST_KEY });
      await queryClient.cancelQueries({ queryKey: detailKey });
      const previous = queryClient.getQueriesData({
        queryKey: ARTICLES_LIST_KEY,
      });
      const previousDetail = queryClient.getQueryData<ArticleDetail>(detailKey);
      // (1) Réplica (vue non-lus local-first) + (2) outbox (push montant).
      const db = await getReplica();
      await setArticleFieldInReplica(db, id, "saved", saved);
      await enqueueOutbox(db, {
        kind: "patch",
        articleId: id,
        field: "saved",
        value: saved,
      });
      // (3) Caches react-query : flip optimiste immédiat des listes (toutes
      // local-first, #73) + du cache détail (deep-link hors liste). Le réplica
      // étant déjà écrit, l'invalidation ci-dessous reconverge ; le flip évite
      // un clignotement le temps de la relecture.
      setArticleSavedInListCaches(queryClient, id, saved);
      setArticleSavedInDetailCache(queryClient, id, saved);
      if (!saved) removeArticleFromSavedCache(queryClient, id);
      // Rafraîchit TOUTES les listes local-first (#73) + les compteurs locaux,
      // qui relisent le réplica fraîchement écrit.
      void queryClient.invalidateQueries({ queryKey: ARTICLES_LIST_KEY });
      void queryClient.invalidateQueries({ queryKey: ARTICLES_COUNTS_KEY });
      void queryClient.invalidateQueries({ queryKey: SEARCH_QUERY_KEY });
      return { previous, previousDetail, detailKey };
    },
    onError: (
      _err: unknown,
      _vars: { id: string; saved: boolean },
      context:
        | {
            previous: [readonly unknown[], unknown][];
            previousDetail: ArticleDetail | undefined;
            detailKey: readonly unknown[];
          }
        | undefined,
    ) => {
      // Le serveur n'a rien changé : on restaure les listes et le détail d'avant.
      for (const [key, data] of context?.previous ?? []) {
        queryClient.setQueryData(key, data);
      }
      if (context) {
        queryClient.setQueryData(context.detailKey, context.previousDetail);
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

/**
 * Portée de « Tout marquer lu » : global, un Feed (#8) ou un Folder (#13).
 * Contrat wire partagé (`@boreas/api-contracts`).
 */
export type MarkReadScope = MarkReadRequest;

/**
 * Options de mutation pour la bascule manuelle Read↔non-lu.
 *
 * **Local-first (#74, ADR 0018)** : `onMutate` écrit l'état Read au **réplica**
 * (la vue non-lus local-first le reflète instantanément, même hors-ligne), au
 * **cache react-query** (vues encore API, #73), puis **empile l'outbox**. C'est
 * ce qui **résout la limitation déférée de #72** : la vue non-lus n'est plus
 * « ressuscitée » par un refetch, car le réplica porte désormais l'état Read.
 * Le `mutationFn` est offline-safe (flush best-effort, ne rejette pas hors-ligne).
 */
export function toggleArticleReadMutationOptions(queryClient: QueryClient) {
  return {
    mutationFn: async ({ read: _read }: { id: string; read: boolean }) => {
      await flushBestEffort();
      return { ok: true } as const;
    },
    onMutate: async ({ id, read }: { id: string; read: boolean }) => {
      // Fige les refetch en vol, puis snapshot des listes pour pouvoir annuler.
      await queryClient.cancelQueries({ queryKey: ARTICLES_LIST_KEY });
      const previous = queryClient.getQueriesData({
        queryKey: ARTICLES_LIST_KEY,
      });
      // (1) Réplica (vue non-lus local-first) + (2) outbox (push montant).
      const db = await getReplica();
      await setArticleFieldInReplica(db, id, "read", read);
      await enqueueOutbox(db, {
        kind: "patch",
        articleId: id,
        field: "read",
        value: read,
      });
      // (3) Caches react-query : flip optimiste immédiat des listes (toutes
      // local-first, #73). Le réplica étant déjà écrit, l'invalidation reconverge.
      setArticleReadInListCaches(queryClient, id, read);
      // Rafraîchit TOUTES les listes local-first (#73) + les compteurs locaux.
      void queryClient.invalidateQueries({ queryKey: ARTICLES_LIST_KEY });
      void queryClient.invalidateQueries({ queryKey: ARTICLES_COUNTS_KEY });
      void queryClient.invalidateQueries({ queryKey: SEARCH_QUERY_KEY });
      return { previous };
    },
    onError: (
      _err: unknown,
      _vars: { id: string; read: boolean },
      context: { previous: [readonly unknown[], unknown][] } | undefined,
    ) => {
      // Garde-fou : si onMutate échoue, on restaure les listes d'avant la bascule.
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
 * Options de mutation pour « Tout marquer lu » sur une portée (global/Feed/Folder).
 *
 * **Local-first (#74, ADR 0018)** : `onMutate` marque `read=true` sur les articles
 * de la portée dans le **réplica** (la vue non-lus se vide instantanément, même
 * hors-ligne), puis **empile une SEULE entrée `markRead`** dans l'outbox — rejouée
 * en **une seule** requête `POST /articles/mark-read {scope}` (pas N patchs).
 * Les caches react-query des vues encore API (#73) sont invalidés. Le `mutationFn`
 * est offline-safe (flush best-effort).
 */
export function markAllReadMutationOptions(queryClient: QueryClient) {
  return {
    mutationFn: async (_scope: MarkReadScope) => {
      await flushBestEffort();
      return { ok: true } as const;
    },
    onMutate: async (scope: MarkReadScope) => {
      // (1) Réplica : marque la portée (vue non-lus local-first).
      const db = await getReplica();
      await markReadInReplica(db, scope);
      // (2) Outbox : UNE entrée de portée (push en une requête, pas N patchs).
      await enqueueOutbox(db, { kind: "markRead", scope });
      // (3) Rafraîchit TOUTES les listes local-first (#73) + les compteurs locaux,
      // qui relisent le réplica fraîchement marqué.
      void queryClient.invalidateQueries({ queryKey: ARTICLES_LIST_KEY });
      void queryClient.invalidateQueries({ queryKey: ARTICLES_COUNTS_KEY });
      void queryClient.invalidateQueries({ queryKey: SEARCH_QUERY_KEY });
    },
  };
}
