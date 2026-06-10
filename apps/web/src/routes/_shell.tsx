import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { AppShell } from "../components/AppShell";
import { sessionQueryOptions } from "../lib/auth";
import { useServerThemeSync } from "../lib/use-theme";

/** Layout commun à toutes les vues applicatives (pathless). La page /login en est
 *  volontairement exclue : elle n'a ni sidebar ni shell. */
export const Route = createFileRoute("/_shell")({
  // Garde d'auth : sans session valide, on redirige vers /login avant de rendre
  // quoi que ce soit. L'état est mis en cache par TanStack Query (ensureQueryData).
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
