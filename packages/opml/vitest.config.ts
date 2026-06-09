import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "opml",
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
