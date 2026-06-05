import type { D1Migration } from "@cloudflare/vitest-pool-workers";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
    HMAC_SECRET: string;
    EMAIL_FROM: string;
    APP_BASE_URL: string;
    ENVIRONMENT: string;
  }
}
