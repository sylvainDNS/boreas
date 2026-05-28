import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // staleTime: 0 (défaut) garantit que refetchOnWindowFocus:true déclenche
      // toujours un refetch, conformément à l'US #39 du PRD.
      refetchOnWindowFocus: true,
    },
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("Élément #root introuvable dans le DOM.");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
