import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Tests de composants React en jsdom (RTL). On n'embarque pas le plugin
// TanStack Router : les tests montent les composants isolément, pas l'arbre de
// routes.
export default defineConfig({
  plugins: [react()],
  test: {
    name: "web",
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
