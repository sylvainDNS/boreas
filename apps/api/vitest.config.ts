import path from "node:path";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

import { silenceSourcemapWarnings } from "../../vitest.logger";

// Les tests tournent dans le runtime Workers (miniflare). On y injecte une D1
// locale migrée depuis le package partagé, et les vars d'auth (e-mail mocké).
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
          // Producteur de la Queue d'ingestion : les messages partent dans le vide
          // (pas de consommateur en test), ce qui suffit aux routes qui enqueue le
          // backfill (import OPML, (ré)abonnement).
          queueProducers: ["INGESTION_QUEUE"],
          bindings: {
            TEST_MIGRATIONS: migrations,
            HMAC_SECRET: "test-secret",
            EMAIL_FROM: "noreply@boreas.sylvaindenyse.me",
            APP_BASE_URL: "http://localhost:5173",
            ENVIRONMENT: "development",
          },
        },
      };
    }),
  ],
  test: {
    name: "api",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/apply-migrations.ts"],
  },
});
