import { queryOptions } from "@tanstack/react-query";
import { apiFetch } from "./api";

/** Clé de cache de l'état de session. */
export const AUTH_QUERY_KEY = ["auth", "session"] as const;

/**
 * Clé `localStorage` du **flag de session réussie antérieure** (#76, ADR 0018
 * « Boot & auth hors-ligne »). Sa seule présence signifie « une validation
 * serveur a déjà réussi sur cet appareil » — c'est ce qui autorise le boot
 * hors-ligne depuis le réplica. Ce n'est **pas** un secret : la véritable auth
 * reste le cookie de session + l'API Worker (ADR 0005/0008).
 */
export const SESSION_REMEMBERED_KEY = "boreas.session";

/** Mémorise qu'une validation serveur a réussi (best-effort, ne lève jamais). */
export function rememberSession(): void {
  try {
    localStorage.setItem(SESSION_REMEMBERED_KEY, "1");
  } catch {
    // Stockage indisponible (mode privé, quota) : le boot offline sera juste
    // indisponible tant qu'aucune session n'a pu être mémorisée.
  }
}

/** Efface le flag de session mémorisée (déconnexion ou 401 réel). */
export function clearRememberedSession(): void {
  try {
    localStorage.removeItem(SESSION_REMEMBERED_KEY);
  } catch {
    // Idem : on avale toute erreur de stockage.
  }
}

/** Indique si une session réussie a déjà été mémorisée localement. */
export function hasRememberedSession(): boolean {
  try {
    return localStorage.getItem(SESSION_REMEMBERED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Résout l'état de session pour le guard adaptatif (#76, ADR 0018).
 *
 * - **En ligne, 200** → authentifié ; on mémorise la session (autorise les
 *   futurs boots hors-ligne).
 * - **En ligne, 401 réel** → non authentifié ; on **efface** le flag mémorisé
 *   (déconnexion) → le guard redirige vers `/login`.
 * - **Hors-ligne (le `fetch` rejette)** → on **ne déconnecte pas** : on fait
 *   confiance à une session réussie antérieure mémorisée localement. Présence du
 *   flag → boot autorisé ; absence → non authentifié.
 *
 * On ne passe pas par `apiFetch` (qui lèverait sur 401) : ici 401 est une
 * réponse attendue, pas une erreur.
 */
export async function fetchSessionState(): Promise<boolean> {
  let res: Response;
  try {
    res = await fetch("/api/auth/session", { credentials: "include" });
  } catch {
    // Erreur réseau = hors-ligne : on retombe sur la session mémorisée. Le flag
    // n'est jamais effacé ici (une coupure réseau n'est pas une déconnexion).
    return hasRememberedSession();
  }
  if (res.ok) {
    rememberSession();
    return true;
  }
  if (res.status === 401) {
    // 401 réel = déconnexion côté serveur : on oublie la session et on dénie
    // (→ /login). Seul ce cas efface le flag.
    clearRememberedSession();
    return false;
  }
  // Serveur joignable mais en erreur (5xx/403/429…) : on ne déconnecte PAS pour
  // un incident transitoire. On dégrade comme hors-ligne — confiance à la session
  // mémorisée — plutôt que d'éjecter vers /login (où l'utilisateur, probablement
  // toujours valide, ne pourrait de toute façon pas se reconnecter) un temps que
  // l'API est KO. Une vraie révocation se manifesterait par un 401, traité ci-dessus.
  return hasRememberedSession();
}

/**
 * État de session pour le guard du SPA (ADR 0005). Le `queryFn` est adaptatif
 * online/offline (cf. `fetchSessionState`).
 */
export const sessionQueryOptions = () =>
  queryOptions({
    queryKey: AUTH_QUERY_KEY,
    queryFn: fetchSessionState,
    staleTime: 30_000,
  });

/** Demande l'envoi d'un magic link à l'adresse saisie. */
export function requestMagicLink(email: string): Promise<unknown> {
  return apiFetch("/auth/request", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

/** Coupe la session côté serveur (le cookie est supprimé par la réponse). */
export async function logout(): Promise<void> {
  try {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
  } catch {
    // Hors-ligne : le serveur est injoignable. La déconnexion reste best-effort —
    // on efface tout de même le flag local (ci-dessous) et l'appelant poursuit son
    // nettoyage (cache, redirection /login) ; la session serveur, si encore vivante,
    // sera revalidée puis re-déconnectable au retour en ligne.
  } finally {
    // Déconnexion explicite : on oublie la session mémorisée **quoi qu'il arrive**
    // pour ne pas autoriser un boot offline « fantôme » après un logout volontaire.
    clearRememberedSession();
  }
}
