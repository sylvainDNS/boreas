import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { AppShell } from "../components/AppShell";
import { sessionQueryOptions } from "../lib/auth";
import { useServerThemeSync } from "../lib/theme";

/** Layout commun à toutes les vues applicatives (pathless). La page /login en est
 *  volontairement exclue : elle n'a ni sidebar ni shell. */
export const Route = createFileRoute("/_shell")({
  // Garde d'auth **adaptatif** (#76, ADR 0018 « Boot & auth hors-ligne »). Le
  // `queryFn` (`fetchSessionState`) encapsule la logique online/offline :
  //  - en ligne : validation serveur (200 → ok, 401 → non, inchangé ADR 0005) ;
  //  - hors-ligne (le `fetch` rejette) : on fait confiance à une session réussie
  //    antérieure mémorisée localement → boot autorisé depuis le réplica.
  // Ici on ne redirige donc vers /login que sur un `false` — soit un 401 réel à
  // la reconnexion, soit une absence de session mémorisée hors-ligne — jamais
  // sur une simple erreur réseau. L'état est mis en cache par TanStack Query.
  beforeLoad: async ({ context }) => {
    const authenticated = await context.queryClient.ensureQueryData(
      sessionQueryOptions(),
    );
    if (!authenticated) {
      throw redirect({ to: "/login" });
    }
  },
  component: ShellLayout,
});

function ShellLayout() {
  // Applique le thème persisté côté serveur dans toute l'app (#18), pas seulement
  // sur l'écran réglages.
  useServerThemeSync();
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
