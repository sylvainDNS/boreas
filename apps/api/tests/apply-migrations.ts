import { applyD1Migrations, env } from "cloudflare:test";

// Applique le schéma partagé (tables + seed settings) à la D1 de test avant
// la suite. La ligne `settings` (avec `allowed_email`) provient du seed 0001.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
