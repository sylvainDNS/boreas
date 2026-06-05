import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "content-extractor",
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
