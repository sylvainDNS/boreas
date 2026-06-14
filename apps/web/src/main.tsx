import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { initTheme } from "./lib/theme";
import { routeTree } from "./routeTree.gen";
import "./styles/app.css";

/**
 * Enregistrement du SW (#76) chargé en **lazy** : il importe le module virtuel
 * `virtual:pwa-register/react` (résolu uniquement par le build Vite). On ne le
 * monte qu'en PROD pour le garder **inerte sous dev/test** — vite-plugin-pwa ne
 * génère pas de SW en dev par défaut, et le module n'entre jamais dans le graphe
 * des tests jsdom.
 */
const RegisterSW = lazy(() =>
  import("./components/register-sw").then((m) => ({ default: m.RegisterSW })),
);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // staleTime: 0 (défaut) garantit que refetchOnWindowFocus:true déclenche
      // toujours un refetch, conformément à l'US #39 du PRD.
      refetchOnWindowFocus: true,
    },
  },
});

const router = createRouter({ routeTree, context: { queryClient } });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

// Applique le thème (clair/sombre/système) avant le premier rendu.
initTheme();

const root = document.getElementById("root");
if (!root) throw new Error("Élément #root introuvable dans le DOM.");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      {/* SW + bandeau de MAJ + storage.persist, uniquement en build prod. */}
      {import.meta.env.PROD && (
        <Suspense fallback={null}>
          <RegisterSW />
        </Suspense>
      )}
    </QueryClientProvider>
  </StrictMode>,
);
