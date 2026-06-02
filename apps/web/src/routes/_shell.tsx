import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AppShell } from "../components/AppShell";

/** Layout commun à toutes les vues applicatives (pathless). La page /login en est
 *  volontairement exclue : elle n'a ni sidebar ni shell. */
export const Route = createFileRoute("/_shell")({
  component: ShellLayout,
});

function ShellLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
