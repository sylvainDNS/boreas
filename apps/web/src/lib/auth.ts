import { queryOptions } from "@tanstack/react-query";
import { apiFetch } from "./api";

/** Clé de cache de l'état de session. */
export const AUTH_QUERY_KEY = ["auth", "session"] as const;

/**
 * État de session pour le guard du SPA. 200 → authentifié, 401 → non.
 * On ne passe pas par `apiFetch` (qui lèverait sur 401) : ici 401 est une
 * réponse attendue, pas une erreur.
 */
export const sessionQueryOptions = () =>
  queryOptions({
    queryKey: AUTH_QUERY_KEY,
    queryFn: async () => {
      const res = await fetch("/api/auth/session", { credentials: "include" });
      return res.ok;
    },
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
  await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
}
