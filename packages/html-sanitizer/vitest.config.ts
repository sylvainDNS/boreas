import { defineConfig } from "vitest/config";

import { silenceSourcemapWarnings } from "../../vitest.logger";

export default defineConfig({
  plugins: [silenceSourcemapWarnings()],
  test: {
    name: "html-sanitizer",
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
