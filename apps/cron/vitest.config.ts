import path from "node:path";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

import { silenceSourcemapWarnings } from "../../vitest.logger";

// Les tests tournent dans le runtime Workers (miniflare). On y injecte une D1
// locale migrée depuis le package partagé et un bucket R2 local : la rétention
// (#15) touche les deux stores, on la teste donc contre de vrais bindings.
const migrationsPath = path.join(
  import.meta.dirname,
  "../../packages/shared/migrations",
);

export default defineConfig({
  plugins: [
    silenceSourcemapWarnings(),
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(migrationsPath);
      return {
        main: "./src/index.ts",
        miniflare: {
          compatibilityDate: "2026-01-01",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: ["DB"],
          r2Buckets: ["BUCKET"],
          bindings: {
            TEST_MIGRATIONS: migrations,
          },
        },
      };
    }),
  ],
  test: {
    name: "cron",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/apply-migrations.ts"],
  },
});
