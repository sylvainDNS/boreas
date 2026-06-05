import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "html-sanitizer",
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
