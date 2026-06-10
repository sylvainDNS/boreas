import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "api-contracts",
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
