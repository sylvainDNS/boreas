import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { AUTH_QUERY_KEY, logout } from "../lib/auth";
import { Button } from "./ui/Button";

/**
 * Action « Se déconnecter » des Réglages (#116). Déplace ici le logout qui
 * vivait dans la Sidebar : coupe la session côté serveur (best-effort, cf.
 * `logout`), invalide le cache de session (→ le guard redirige), puis navigue
 * vers `/login`.
 *
 * Variante **neutre** (`outline`) : la déconnexion n'est pas destructive (pas de
 * `danger`). Logique inline — un seul consommateur. Désactivé pendant l'appel
 * pour éviter les double-clics. Pattern async local (`pending`) calqué sur
 * `ResetReplicaButton`.
 */
export function LogoutButton() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);

  async function onLogout() {
    setPending(true);
    try {
      await logout();
      queryClient.setQueryData(AUTH_QUERY_KEY, false);
      await navigate({ to: "/login" });
    } finally {
      // `logout` ne jette jamais, mais une `navigate` qui rejetterait (cas rare)
      // ne doit pas figer le bouton désactivé à vie : on relâche `pending` quoi
      // qu'il arrive. En cas de succès, la route change et le composant se
      // démonte avant que ce `setState` n'ait d'effet visible.
      setPending(false);
    }
  }

  return (
    <Button variant="outline" disabled={pending} onClick={onLogout}>
      Se déconnecter
    </Button>
  );
}
