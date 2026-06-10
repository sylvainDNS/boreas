import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  settingsQueryOptions,
  updateSettingsMutationOptions,
} from "./settings";
import {
  getStoredPreference,
  setPreference,
  subscribePreference,
  type ThemePreference,
} from "./theme";

/**
 * Expose la préférence de thème et un setter qui :
 *  1. persiste + applique localement (localStorage + `data-theme`), instantané et
 *     sans flash au démarrage — autorité d'affichage ;
 *  2. propage le choix au serveur (`PATCH /settings`, #18), fire-and-forget : une
 *     erreur réseau est ignorée car l'affichage est déjà persisté localement.
 *
 * La préférence est lue via `useSyncExternalStore` : une seule source de vérité
 * (localStorage + abonnés) partagée par tous les `ThemeToggle` (sidebar comme
 * écran réglages), donc tout changement — y compris la réconciliation serveur →
 * local — met à jour chaque toggle.
 */
export function useTheme() {
  const preference = useSyncExternalStore(
    subscribePreference,
    getStoredPreference,
    getStoredPreference,
  );
  const queryClient = useQueryClient();
  // `mutate` est stable entre rendus (react-query) → callback stable.
  const { mutate } = useMutation(updateSettingsMutationOptions(queryClient));

  const set = useCallback(
    (pref: ThemePreference) => {
      setPreference(pref);
      mutate({ theme: pref });
    },
    [mutate],
  );

  return { preference, setPreference: set };
}

/**
 * Réconcilie le thème serveur → local au niveau de l'app (monté dans le shell) :
 * sur un appareil neuf dont la préférence locale diffère de celle persistée
 * côté serveur, applique la valeur serveur partout, pas seulement sur /settings.
 * `useTheme` reste l'autorité au changement.
 */
export function useServerThemeSync(): void {
  const { data } = useQuery(settingsQueryOptions());
  const serverTheme = data?.theme;
  useEffect(() => {
    if (serverTheme && serverTheme !== getStoredPreference()) {
      setPreference(serverTheme);
    }
  }, [serverTheme]);
}
