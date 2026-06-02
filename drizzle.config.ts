import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./packages/shared/src/db/schema.ts",
  out: "./packages/shared/migrations",
  dialect: "sqlite",
});
