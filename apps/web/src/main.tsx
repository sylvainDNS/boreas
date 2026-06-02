import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { initTheme } from "./lib/theme";
import { routeTree } from "./routeTree.gen";
import "./styles/app.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // staleTime: 0 (défaut) garantit que refetchOnWindowFocus:true déclenche
      // toujours un refetch, conformément à l'US #39 du PRD.
      refetchOnWindowFocus: true,
    },
  },
});

const router = createRouter({ routeTree });

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
    </QueryClientProvider>
  </StrictMode>,
);
