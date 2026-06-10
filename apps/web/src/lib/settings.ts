import type { QueryClient } from "@tanstack/react-query";
import { queryOptions } from "@tanstack/react-query";
import { apiFetch } from "./api";
import type { ThemePreference } from "./theme";

/**
 * Réglages globaux (#18). `refreshIntervalMin` pilote la cadence du Cron (#10),
 * `purgeWindowDays` le seuil de rétention (#15), `theme` l'apparence du SPA (#4).
 * Miroir de la réponse `GET /api/settings` (clés camelCase).
 */
export interface Settings {
  refreshIntervalMin: number;
  purgeWindowDays: number;
  theme: ThemePreference;
}

/** Clé du cache des réglages. */
export const SETTINGS_QUERY_KEY = ["settings"] as const;

/** Query des réglages courants (`GET /api/settings`). */
export function settingsQueryOptions() {
  return queryOptions({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: () => apiFetch<Settings>("/settings"),
  });
}

/**
 * Mutation de mise à jour partielle (`PATCH /api/settings`). Le PATCH renvoie la
 * ligne à jour : on l'écrit directement dans le cache (`setQueryData`) plutôt que
 * d'invalider, ce qui évite un GET réseau redondant à chaque réglage modifié /
 * bascule de thème. Le changement de thème emprunte aussi ce chemin (sync
 * serveur, #18) ; voir `useTheme`.
 */
export function updateSettingsMutationOptions(queryClient: QueryClient) {
  return {
    mutationFn: (updates: Partial<Settings>) =>
      apiFetch<Settings>("/settings", {
        method: "PATCH",
        body: JSON.stringify(updates),
      }),
    onSuccess: (data: Settings) => {
      queryClient.setQueryData(SETTINGS_QUERY_KEY, data);
    },
  };
}
