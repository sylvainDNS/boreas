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
 * Soumet une URL (de flux **ou** de site) à `POST /api/feeds`. Le backend tente
 * l'abonnement direct puis, à défaut, l'auto-découverte : il renvoie soit le
 * feed abonné (201), soit la liste des flux candidats (200). On distingue les
 * deux par la présence de `candidates` dans le corps.
 */
export async function submitFeedUrl(url: string): Promise<SubscribeOutcome> {
  const body = await apiFetch<
    SubscribeSubscribedResponse | SubscribeCandidatesResponse
  >("/feeds", {
    method: "POST",
    body: JSON.stringify({ url }),
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
    mutationFn: (url: string) => submitFeedUrl(url),
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
