import { useSyncExternalStore } from "react";

/**
 * État de connexion réseau (#81, ADR 0018 « Affordances UI ») : `navigator.onLine`
 * tenu à jour par les events `online`/`offline`. Lu via `useSyncExternalStore`
 * pour une seule source de vérité partagée (indicateur de connexion, gating des
 * ops Feeds/Folders online-only) sans état React dupliqué par composant.
 *
 * `navigator.onLine` est best-effort par nature (un `true` ne garantit pas un
 * accès Internet réel, seulement une interface up) : c'est suffisant pour
 * **désactiver visiblement** les ops réseau et afficher un état hors-ligne — la
 * source de vérité de la lecture reste le réplica local, jamais bloqué.
 */

/** S'abonne aux transitions online/offline du navigateur. */
function subscribe(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

/** Snapshot courant : `navigator.onLine` (par défaut `true` si l'API est absente). */
function getSnapshot(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

/** Côté serveur (jamais hors-ligne au rendu initial) : on suppose en ligne. */
function getServerSnapshot(): boolean {
  return true;
}

/** `true` si le navigateur se croit en ligne ; réactif aux events online/offline. */
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
