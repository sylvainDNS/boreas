// Politique unique du thème clair/sombre du shell. Source de vérité d'affichage =
// localStorage (application instantanée, zéro flash au démarrage) ; la synchro avec
// settings.theme (serveur) est faite par `useTheme` au changement (PATCH
// fire-and-forget) et réconciliée serveur→local au chargement par `useServerThemeSync`
// (#18). Tout vit ici : primitives pures (testables hors React, importables avant
// React par `main.tsx` via `initTheme`) en tête, puis les deux hooks.

import type { Theme } from "@boreas/api-contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  settingsQueryOptions,
  updateSettingsMutationOptions,
} from "./settings";

/**
 * Préférence choisie par l'utilisateur. Ré-export de l'enum partagé `Theme`
 * (source de vérité unique, `@boreas/api-contracts`), aligné sur `settings.theme`.
 */
export type ThemePreference = Theme;
/** Thème effectivement appliqué (jamais "system"). */
type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "boreas.theme";
const prefersDark = () =>
  window.matchMedia("(prefers-color-scheme: dark)").matches;

// Abonnés notifiés à chaque écriture de préférence : permet à tout `useTheme`
// (via useSyncExternalStore) de rester la seule source de vérité, sans état
// React dupliqué par instance de ThemeToggle.
const listeners = new Set<() => void>();

/** S'abonne aux changements de préférence (pour useSyncExternalStore). */
export function subscribePreference(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

export function getStoredPreference(): ThemePreference {
  // localStorage peut lever (Safari « bloquer tous les cookies », mode privé) :
  // on retombe alors sur "system" plutôt que de faire échouer le montage de l'app.
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return "system";
  }
  return raw === "light" || raw === "dark" || raw === "system" ? raw : "system";
}

function resolveTheme(pref: ThemePreference): ResolvedTheme {
  if (pref === "system") return prefersDark() ? "dark" : "light";
  return pref;
}

/** Applique le thème résolu en posant `data-theme` sur <html>. */
function applyTheme(pref: ThemePreference): void {
  document.documentElement.dataset.theme = resolveTheme(pref);
}

/** Persiste la préférence et l'applique immédiatement. */
export function setPreference(pref: ThemePreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // Stockage indisponible : le thème s'applique pour la session, sans persistance.
  }
  applyTheme(pref);
  // Notifie tous les `useTheme` montés (sidebar, réglages) pour qu'ils reflètent
  // le nouveau choix, quelle que soit l'origine de l'écriture (toggle ou réconciliation).
  for (const onChange of listeners) onChange();
}

/** À appeler une fois au démarrage : applique le thème + suit les changements
 *  système tant que la préférence est "system". Retourne une fonction de nettoyage. */
export function initTheme(): () => void {
  applyTheme(getStoredPreference());
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    if (getStoredPreference() === "system") applyTheme("system");
  };
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

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
