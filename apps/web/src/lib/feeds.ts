import type {
  DiscoveredFeed,
  Feed,
  FeedsResponse,
  FeedUnsubscribedResponse,
  FeedUpdatedResponse,
  SubscribeCandidatesResponse,
  SubscribeSubscribedResponse,
} from "@boreas/api-contracts";
import type { QueryClient } from "@tanstack/react-query";
import { queryOptions } from "@tanstack/react-query";
import { apiFetch } from "./api";
import {
  ARTICLES_COUNTS_KEY,
  ARTICLES_LIST_KEY,
  POLL_INTERVAL_MS,
} from "./articles";

/**
 * Santé d'un Feed côté SPA (#11). `status` pilote le badge « en erreur » de la
 * sidebar ; `lastError` alimente l'info-bulle (code brut, ex. `http_404`).
 * Contrat wire partagé (`@boreas/api-contracts`).
 */
export type { DiscoveredFeed, Feed };

/** Clé du cache de la liste des feeds. */
export const FEEDS_LIST_KEY = ["feeds", "list"] as const;

/**
 * Query de la liste des feeds avec leur santé (`GET /api/feeds`, #11). Polle au
 * même rythme que les listes d'articles (`POLL_INTERVAL_MS`) : un feed qui
 * bascule en erreur en arrière-plan (Cron) fait apparaître son badge sans
 * action de l'utilisateur.
 */
export function feedsQueryOptions() {
  return queryOptions({
    queryKey: FEEDS_LIST_KEY,
    queryFn: async () => (await apiFetch<FeedsResponse>("/feeds")).feeds,
    refetchInterval: POLL_INTERVAL_MS,
  });
}

/** Libellé d'affichage d'un feed : son titre, à défaut son URL. */
export function feedLabel(feed: Pick<Feed, "title" | "url">): string {
  return feed.title ?? feed.url;
}

/**
 * Issue de `POST /api/feeds` (#12) : soit l'abonnement a réussi (URL de flux ou
 * URL de site mono-flux), soit le site expose plusieurs flux et il faut en
 * choisir un (`candidates`). **Modèle de vue local** (discriminé sur `kind`),
 * distinct des deux réponses wire (`SubscribeSubscribedResponse` /
 * `SubscribeCandidatesResponse`) qu'il fusionne pour le composant.
 */
export type SubscribeOutcome =
  | {
      kind: "subscribed";
      feed: { id: string; url: string; title: string | null };
      articleCount: number;
    }
  | { kind: "candidates"; candidates: DiscoveredFeed[] };

/**
 * Variables d'une mutation d'abonnement (#118) : l'URL à suivre et, en option,
 * le dossier cible. `folderId` à `null`/absent = abonnement « sans dossier » (le
 * « + » pré-scopé d'un dossier le renseigne, cf. #118 / route `POST /api/feeds`
 * #117).
 */
export interface SubscribeFeedVars {
  url: string;
  /** Dossier cible (#118) : non vide → flux créé dedans ; `null`/absent = sans dossier. */
  folderId?: string | null;
}

/**
 * Soumet une URL (de flux **ou** de site) à `POST /api/feeds`. Le backend tente
 * l'abonnement direct puis, à défaut, l'auto-découverte : il renvoie soit le
 * feed abonné (201), soit la liste des flux candidats (200). On distingue les
 * deux par la présence de `candidates` dans le corps. `folderId` (#118),
 * lorsqu'il est non nul, est joint au corps pour pré-scoper l'abonnement à ce
 * dossier ; sinon il est **omis** (et non envoyé à `null`) — le backend traite
 * l'absence comme « sans dossier ».
 */
export async function submitFeedUrl(
  url: string,
  folderId?: string | null,
): Promise<SubscribeOutcome> {
  const body = await apiFetch<
    SubscribeSubscribedResponse | SubscribeCandidatesResponse
  >("/feeds", {
    method: "POST",
    body: JSON.stringify({ url, ...(folderId != null ? { folderId } : {}) }),
  });
  if ("candidates" in body) {
    return { kind: "candidates", candidates: body.candidates };
  }
  return {
    kind: "subscribed",
    feed: body.feed,
    articleCount: body.articleCount,
  };
}

/**
 * Mutation d'abonnement (#12). En cas de succès (`subscribed`), invalide les
 * listes de feeds et d'articles + les compteurs pour faire apparaître le nouveau
 * flux et ses articles. Sur `candidates`, rien n'est abonné : l'appelant affiche
 * le sélecteur (l'invalidation reste sans effet, on la fait au prochain succès).
 */
export function subscribeFeedMutationOptions(queryClient: QueryClient) {
  return {
    mutationFn: ({ url, folderId }: SubscribeFeedVars) =>
      submitFeedUrl(url, folderId),
    onSuccess: (outcome: SubscribeOutcome) => {
      if (outcome.kind !== "subscribed") return;
      invalidateAfterFeedLifecycle(queryClient);
    },
  };
}

/** Champs modifiables d'un Feed (#13) : titre et/ou rattachement à un Folder. */
export interface UpdateFeedInput {
  id: string;
  /** Nouveau titre (renommage), ou laissé absent pour ne pas y toucher. */
  title?: string;
  /** Folder cible : `null` désassigne ; absent = inchangé. */
  folderId?: string | null;
}

/**
 * Mutation de renommage et/ou déplacement d'un Feed (`PATCH /api/feeds/:id`, US
 * 12 / #13). **Optimiste sur le déplacement** : `onMutate` réécrit
 * immédiatement le `folderId` dans le cache `FEEDS_LIST_KEY` pour que le drag-n-
 * drop reclasse le Feed sans attendre l'aller-retour réseau ; `onError` restaure
 * **uniquement le folderId du feed concerné** (et non un instantané de toute la
 * liste), afin qu'un rollback n'écrase pas un déplacement concurrent encore en
 * vol. `onSettled` réconcilie via `invalidateAfterFeedLifecycle` : indispensable
 * pour les **compteurs par dossier** (`ARTICLES_COUNTS_KEY`), non réécrits à la
 * main. Le renommage emprunte le même chemin (le `folderId` absent du patch
 * laisse le cache intact).
 */
export function updateFeedMutationOptions(queryClient: QueryClient) {
  return {
    mutationFn: ({ id, ...patch }: UpdateFeedInput) =>
      apiFetch<FeedUpdatedResponse>(`/feeds/${id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    onMutate: async ({
      id,
      folderId,
    }: UpdateFeedInput): Promise<{
      rollback?: { id: string; folderId: string | null };
    }> => {
      // Seul le déplacement est optimiste : un patch sans `folderId` (renommage
      // pur) ne touche pas au regroupement, on laisse `onSettled` réconcilier.
      if (folderId === undefined) return {};
      await queryClient.cancelQueries({ queryKey: FEEDS_LIST_KEY });
      const previous = queryClient
        .getQueryData<Feed[]>(FEEDS_LIST_KEY)
        ?.find((feed) => feed.id === id);
      if (!previous) return {};
      queryClient.setQueryData<Feed[]>(FEEDS_LIST_KEY, (feeds) =>
        feeds?.map((feed) => (feed.id === id ? { ...feed, folderId } : feed)),
      );
      return { rollback: { id, folderId: previous.folderId } };
    },
    onError: (
      _error: unknown,
      _vars: UpdateFeedInput,
      context:
        | { rollback?: { id: string; folderId: string | null } }
        | undefined,
    ) => {
      const rollback = context?.rollback;
      if (!rollback) return;
      queryClient.setQueryData<Feed[]>(FEEDS_LIST_KEY, (feeds) =>
        feeds?.map((feed) =>
          feed.id === rollback.id
            ? { ...feed, folderId: rollback.folderId }
            : feed,
        ),
      );
    },
    onSettled: () => invalidateAfterFeedLifecycle(queryClient),
  };
}

/** Champs d'un réordonnancement de Feed (#111) : id ciblé + nouveau rang. */
export interface ReorderFeedInput {
  id: string;
  /** Rang fractionnaire calculé côté client (`rankBetween` des voisins, ADR 0020). */
  rank: string;
}

/**
 * Trie une liste de Feeds par conteneur (`folderId`, `null` en premier) puis par
 * rang fractionnaire, `id` en départage — **même ordre total déterministe** que
 * `GET /api/feeds` (`ORDER BY folder_id, rank, id`, où SQLite range les `NULL`
 * en tête en ASC). Pur, hors React. Garantit que l'écriture optimiste reflète
 * exactement l'ordre que le prochain poll renverra.
 */
function sortFeedsByRank(list: readonly Feed[]): Feed[] {
  return [...list].sort((a, b) => {
    // `folderId` null (zone sans dossier) avant tout Folder, comme SQLite ASC.
    if (a.folderId !== b.folderId) {
      if (a.folderId === null) return -1;
      if (b.folderId === null) return 1;
      return a.folderId.localeCompare(b.folderId);
    }
    return a.rank.localeCompare(b.rank) || a.id.localeCompare(b.id);
  });
}

/**
 * Applique un `patch` (rang et/ou conteneur) au Feed `id` dans le cache
 * `FEEDS_LIST_KEY` puis **re-trie** la liste globale (ordre canonique par
 * conteneur puis rang). Cœur partagé des écritures optimistes/rollbacks de
 * réordonnancement (#111) et de déplacement positionné (#112) : un seul chemin
 * map+re-tri, pour que le rollback inverse exactement l'écriture (pas de
 * divergence) et qu'une évolution du tri/cache ne se corrige qu'à un endroit.
 */
function patchFeedAndResort(
  queryClient: QueryClient,
  id: string,
  patch: Partial<Pick<Feed, "rank" | "folderId">>,
): void {
  queryClient.setQueryData<Feed[]>(FEEDS_LIST_KEY, (feeds) =>
    feeds
      ? sortFeedsByRank(
          feeds.map((feed) => (feed.id === id ? { ...feed, ...patch } : feed)),
        )
      : feeds,
  );
}

/**
 * Mutation de **réordonnancement** d'un Feed au sein de son conteneur
 * (`PATCH /api/feeds/:id {rank}`, #111). **Optimiste** (calquée sur
 * `reorderFolderMutationOptions`, #109) : `onMutate` annule les requêtes en vol,
 * capture le rang précédent du feed ciblé puis réécrit son rang dans le cache
 * `FEEDS_LIST_KEY` **et re-trie** la liste globale (par conteneur puis rang) pour
 * que la sidebar reflète le nouvel ordre sans attendre l'aller-retour. `onError`
 * restaure **uniquement le rang du feed concerné** (pas un instantané global),
 * afin qu'un rollback n'écrase pas un réordonnancement concurrent. `onSettled`
 * invalide **uniquement** `FEEDS_LIST_KEY` : l'ordre n'affecte pas les non-lus,
 * on ne touche donc pas aux compteurs (contrairement au déplacement #13).
 * **Online-only** (ADR 0018, ADR 0020).
 */
export function reorderFeedMutationOptions(queryClient: QueryClient) {
  return {
    mutationFn: ({ id, rank }: ReorderFeedInput) =>
      apiFetch<FeedUpdatedResponse>(`/feeds/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ rank }),
      }),
    onMutate: async ({
      id,
      rank,
    }: ReorderFeedInput): Promise<{
      rollback?: { id: string; rank: string };
    }> => {
      await queryClient.cancelQueries({ queryKey: FEEDS_LIST_KEY });
      const previous = queryClient
        .getQueryData<Feed[]>(FEEDS_LIST_KEY)
        ?.find((feed) => feed.id === id);
      if (!previous) return {};
      patchFeedAndResort(queryClient, id, { rank });
      return { rollback: { id, rank: previous.rank } };
    },
    onError: (
      _error: unknown,
      _vars: ReorderFeedInput,
      context: { rollback?: { id: string; rank: string } } | undefined,
    ) => {
      const rollback = context?.rollback;
      if (!rollback) return;
      patchFeedAndResort(queryClient, rollback.id, { rank: rollback.rank });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: FEEDS_LIST_KEY });
    },
  };
}

/**
 * Champs d'un **déplacement inter-conteneur à position précise** (#112) : id
 * ciblé, conteneur cible (`null` = zone sans dossier) et rang d'insertion.
 */
export interface MoveAndRankFeedInput {
  id: string;
  /** Folder cible : `null` désassigne (zone « sans dossier »). */
  folderId: string | null;
  /** Rang fractionnaire calculé à la position d'insertion (`rankAtInsertion`, ADR 0020). */
  rank: string;
}

/**
 * Mutation de **déplacement inter-conteneur ET positionnement** d'un Feed en un
 * seul PATCH atomique (`PATCH /api/feeds/:id {folderId, rank}`, #112). Corrige la
 * limitation laissée par #111 : un drop sortable cross-conteneur réattribuait un
 * rang en fin de cible (#110) au lieu de respecter la position de dépose. Le rang
 * explicite **prime** sur la réattribution auto côté serveur (cf. route PATCH).
 *
 * **Optimiste**, jumeau de `reorderFeedMutationOptions` mais réécrivant **folderId
 * ET rang** : `onMutate` capture `{folderId, rank}` précédents du **seul feed
 * concerné** (pas un instantané global, pour ne pas écraser un déplacement
 * concurrent), réécrit les deux via `patchFeedAndResort` et re-trie la liste
 * globale. `onError` restaure ces deux champs par le même chemin. `onSettled`
 * passe par `invalidateAfterFeedLifecycle` — comme le move #13, il invalide
 * **aussi** les compteurs par dossier (`ARTICLES_COUNTS_KEY`), le feed changeant
 * de conteneur. **Online-only** (ADR 0018, ADR 0020).
 */
export function moveAndRankFeedMutationOptions(queryClient: QueryClient) {
  return {
    mutationFn: ({ id, folderId, rank }: MoveAndRankFeedInput) =>
      apiFetch<FeedUpdatedResponse>(`/feeds/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ folderId, rank }),
      }),
    onMutate: async ({
      id,
      folderId,
      rank,
    }: MoveAndRankFeedInput): Promise<{
      rollback?: { id: string; folderId: string | null; rank: string };
    }> => {
      await queryClient.cancelQueries({ queryKey: FEEDS_LIST_KEY });
      const previous = queryClient
        .getQueryData<Feed[]>(FEEDS_LIST_KEY)
        ?.find((feed) => feed.id === id);
      if (!previous) return {};
      patchFeedAndResort(queryClient, id, { folderId, rank });
      return {
        rollback: { id, folderId: previous.folderId, rank: previous.rank },
      };
    },
    onError: (
      _error: unknown,
      _vars: MoveAndRankFeedInput,
      context:
        | { rollback?: { id: string; folderId: string | null; rank: string } }
        | undefined,
    ) => {
      const rollback = context?.rollback;
      if (!rollback) return;
      patchFeedAndResort(queryClient, rollback.id, {
        folderId: rollback.folderId,
        rank: rollback.rank,
      });
    },
    onSettled: () => invalidateAfterFeedLifecycle(queryClient),
  };
}

/**
 * Invalide la liste des feeds + listes/compteurs d'articles. Partagé par toutes
 * les mutations qui font apparaître ou disparaître un feed et/ou ses articles :
 * abonnement (#12), renommage/déplacement (#13), désabonnement/suppression (#14).
 * Centralisé pour qu'une clé dépendant d'un feed ajoutée ici le soit partout.
 */
export function invalidateAfterFeedLifecycle(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: FEEDS_LIST_KEY });
  void queryClient.invalidateQueries({ queryKey: ARTICLES_LIST_KEY });
  void queryClient.invalidateQueries({ queryKey: ARTICLES_COUNTS_KEY });
}

/**
 * Mutation de **désabonnement** (`POST /api/feeds/:id/unsubscribe`, #14). Action
 * non destructive : arrête le polling, purge les articles non-Saved, conserve
 * les Saved. Le feed est masqué de la sidebar (invalidation des feeds), ses
 * articles non-Saved disparaissent des listes/compteurs.
 */
export function unsubscribeFeedMutationOptions(queryClient: QueryClient) {
  return {
    mutationFn: (id: string) =>
      apiFetch<FeedUnsubscribedResponse>(`/feeds/${id}/unsubscribe`, {
        method: "POST",
      }),
    onSuccess: () => invalidateAfterFeedLifecycle(queryClient),
  };
}
