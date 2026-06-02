import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "shared",
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
