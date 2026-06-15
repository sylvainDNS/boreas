// Réglage **local au device** « Télécharger le contenu en Wi-Fi uniquement »
// (#81, ADR 0018). Contrairement à `settings.theme` (serveur), c'est une
// préférence **par appareil** : on roule en Wi-Fi sur un téléphone mais pas sur
// l'autre. Elle vit donc en `localStorage` (jamais poussée au serveur), sur le
// même patron que `theme.ts` : primitives pures testables en tête (lecture/
// écriture localStorage + détection réseau via la Network Information API), puis
// un hook `useSyncExternalStore` partagé.
//
// Sémantique du gating : quand le réglage est **ON** et que la connexion est
// **mesurée/cellulaire**, le moteur de sync **saute le téléchargement du contenu
// lourd** (HTML + images) — mais le **pull du delta (métadonnées) tourne
// toujours**. Indéterminé (API absente) → on **ne bloque pas** (best-effort :
// l'absence de signal ne doit pas priver de contenu un utilisateur en Wi-Fi).

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "boreas.wifiOnly";

// Abonnés notifiés à chaque écriture, pour que tout `useWifiOnly` (via
// useSyncExternalStore) reste sur une seule source de vérité (localStorage),
// sans état React dupliqué entre le toggle des Réglages et d'éventuels lecteurs.
const listeners = new Set<() => void>();

/** S'abonne aux changements de préférence (pour useSyncExternalStore). */
export function subscribeWifiOnly(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/**
 * Lit la préférence (défaut **off**). `localStorage` peut lever (Safari « bloquer
 * tous les cookies », mode privé) : on retombe alors sur `false` plutôt que de
 * faire échouer un montage.
 */
export function getWifiOnly(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Persiste la préférence et notifie les abonnés (toggles montés). */
export function setWifiOnly(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
  } catch {
    // Stockage indisponible : la préférence ne persiste pas, sans faire échouer
    // l'UI ; le gating retombera sur le défaut (off) à la prochaine lecture.
  }
  for (const onChange of listeners) onChange();
}

/**
 * Interface **minimale** de la Network Information API (`navigator.connection`),
 * non-standard et partielle selon les navigateurs (absente sur Safari/Firefox).
 * Typée prudemment (pas de `any`) : tous les champs sont optionnels, on ne lit
 * que ce dont on a besoin pour décider « connexion mesurée/cellulaire ».
 */
interface NetworkInformation {
  /** Type de connexion physique (`'cellular'`, `'wifi'`, `'ethernet'`…). */
  type?: string;
  /** Estimation de la qualité (`'slow-2g'`, `'2g'`, `'3g'`, `'4g'`). */
  effectiveType?: string;
  /** Mode « économie de données » demandé par l'utilisateur. */
  saveData?: boolean;
}

function getConnection(): NetworkInformation | undefined {
  return (navigator as Navigator & { connection?: NetworkInformation })
    .connection;
}

/**
 * Vrai si la connexion courante est jugée **mesurée/cellulaire** (au sens du
 * gating Wi-Fi-only). On la considère mesurée quand l'API expose :
 *  - `type === 'cellular'` (signal le plus fiable), ou
 *  - `saveData === true` (l'utilisateur a explicitement demandé d'économiser), ou
 *  - un `effectiveType` lent (`'slow-2g'`/`'2g'`/`'3g'`) — proxy raisonnable d'un
 *    réseau mobile quand `type` n'est pas exposé.
 *
 * **Indéterminé → `false`** (non mesurée) : si l'API est absente ou ne dit rien
 * d'exploitable, on **ne bloque pas** le téléchargement (best-effort, ADR 0018).
 */
export function isMeteredConnection(): boolean {
  const connection = getConnection();
  if (!connection) return false;
  if (connection.type === "cellular") return true;
  if (connection.saveData === true) return true;
  const effective = connection.effectiveType;
  return effective === "slow-2g" || effective === "2g" || effective === "3g";
}

/**
 * Décision de gating du **contenu lourd** (HTML + images) consommée par le
 * moteur de sync : on saute le téléchargement **uniquement** si le réglage est ON
 * **et** que la connexion est mesurée. Le pull du delta (métadonnées) n'appelle
 * jamais cette garde — il tourne toujours.
 */
export function shouldSkipHeavyContent(): boolean {
  return getWifiOnly() && isMeteredConnection();
}

/**
 * Expose la préférence Wi-Fi-only et son setter, lue via `useSyncExternalStore`
 * (source de vérité unique = localStorage + abonnés), partagée par tout toggle
 * monté. Symétrique de `useTheme`, mais **purement local** (aucun PATCH serveur).
 */
export function useWifiOnly(): {
  wifiOnly: boolean;
  setWifiOnly: (value: boolean) => void;
} {
  const wifiOnly = useSyncExternalStore(
    subscribeWifiOnly,
    getWifiOnly,
    getWifiOnly,
  );
  return { wifiOnly, setWifiOnly };
}
