import { defineConfig } from "vitest/config";

// Délègue à la config vitest.config.ts de chaque package dans packages/*.
// Chaque package est la source unique de sa propre configuration de tests.
export default defineConfig({
  test: {
    projects: ["packages/*", "apps/api", "apps/cron", "apps/web"],
  },
});
