import { type ReactNode, useState } from "react";
import { Sidebar } from "./Sidebar";
import { BrandLogo } from "./ui/BrandLogo";
import { IconButton } from "./ui/IconButton";

/** Ossature de l'app : sidebar (fixe en desktop, tiroir en mobile) + contenu.
 *  Le contenu (liste + lecteur, ou réglages) est fourni par la route via <Outlet/>. */
export function AppShell({ children }: { children: ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="flex h-screen flex-col bg-bg text-text">
      {/* Barre mobile (cachée ≥ lg) */}
      <header className="flex h-14 shrink-0 items-center gap-2 border-border border-b px-2 lg:hidden">
        <IconButton
          label="Ouvrir la navigation"
          onClick={() => setDrawerOpen(true)}
        >
          ☰
        </IconButton>
        <BrandLogo />
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Sidebar fixe (desktop) */}
        <aside className="hidden w-64 shrink-0 border-border border-r lg:block">
          <Sidebar />
        </aside>

        {/* Tiroir (mobile) */}
        {drawerOpen && (
          <div className="fixed inset-0 z-40 lg:hidden">
            <button
              type="button"
              aria-label="Fermer la navigation"
              className="absolute inset-0 bg-black/40"
              onClick={() => setDrawerOpen(false)}
            />
            <div className="absolute inset-y-0 left-0 w-72 max-w-[80%] border-border border-r shadow-pop">
              <Sidebar onNavigate={() => setDrawerOpen(false)} />
            </div>
          </div>
        )}

        {/* Contenu de la route */}
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
