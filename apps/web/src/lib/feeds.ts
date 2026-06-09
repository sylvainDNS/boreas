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
 */
export interface Feed {
  id: string;
  url: string;
  title: string | null;
  status: "ok" | "error";
  lastError: string | null;
  lastCheckAt: string | null;
  /** Folder de rattachement (≤ 1), ou `null` si non classé (#13). */
  folderId: string | null;
}

interface FeedsResponse {
  feeds: Feed[];
}

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
 * Flux candidat découvert à partir d'une URL de site (#12). Miroir du type
 * `DiscoveredFeed` côté API ; alimente le sélecteur multi-flux.
 */
export interface DiscoveredFeed {
  url: string;
  title: string | null;
  type: "rss" | "atom";
}

/**
 * Issue de `POST /api/feeds` (#12) : soit l'abonnement a réussi (URL de flux ou
 * URL de site mono-flux), soit le site expose plusieurs flux et il faut en
 * choisir un (`candidates`). Discriminé sur la forme du corps 2xx.
 */
export type SubscribeOutcome =
  | {
      kind: "subscribed";
      feed: { id: string; url: string; title: string | null };
      articleCount: number;
    }
  | { kind: "candidates"; candidates: DiscoveredFeed[] };

interface SubscribedBody {
  feed: { id: string; url: string; title: string | null };
  articleCount: number;
}
interface CandidatesBody {
  candidates: DiscoveredFeed[];
}

/**
 * Soumet une URL (de flux **ou** de site) à `POST /api/feeds`. Le backend tente
 * l'abonnement direct puis, à défaut, l'auto-découverte : il renvoie soit le
 * feed abonné (201), soit la liste des flux candidats (200). On distingue les
 * deux par la présence de `candidates` dans le corps.
 */
export async function submitFeedUrl(url: string): Promise<SubscribeOutcome> {
  const body = await apiFetch<SubscribedBody | CandidatesBody>("/feeds", {
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
      void queryClient.invalidateQueries({ queryKey: FEEDS_LIST_KEY });
      void queryClient.invalidateQueries({ queryKey: ARTICLES_LIST_KEY });
      void queryClient.invalidateQueries({ queryKey: ARTICLES_COUNTS_KEY });
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
 * 12 / #13). Invalide la liste des feeds (regroupement sidebar + libellé) ainsi
 * que les listes et compteurs d'articles : un déplacement change l'appartenance
 * aux vues Folder, un renommage le `feedName` affiché sur chaque carte.
 */
export function updateFeedMutationOptions(queryClient: QueryClient) {
  return {
    mutationFn: ({ id, ...patch }: UpdateFeedInput) =>
      apiFetch<{ id: string }>(`/feeds/${id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: FEEDS_LIST_KEY });
      void queryClient.invalidateQueries({ queryKey: ARTICLES_LIST_KEY });
      void queryClient.invalidateQueries({ queryKey: ARTICLES_COUNTS_KEY });
    },
  };
}
