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
      // Paire VAPID **générée à la volée** pour les tests #79 (jamais commitée,
      // sinon GitGuardian la signale comme clé privée) : signe le JWT et chiffre
      // le push de test ; le fetch sortant est mocké dans les tests.
      const vapidPair = (await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"],
      )) as CryptoKeyPair;
      const exportB64url = async (key: CryptoKey, format: "pkcs8" | "raw") =>
        Buffer.from(
          (await crypto.subtle.exportKey(format, key)) as ArrayBuffer,
        ).toString("base64url");
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
            VAPID_PRIVATE_KEY: await exportB64url(
              vapidPair.privateKey,
              "pkcs8",
            ),
            VAPID_PUBLIC_KEY: await exportB64url(vapidPair.publicKey, "raw"),
            VAPID_SUBJECT: "mailto:test@boreas.test",
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
