import { queryOptions } from "@tanstack/react-query";
import { apiFetch } from "./api";
import { POLL_INTERVAL_MS } from "./articles";

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
