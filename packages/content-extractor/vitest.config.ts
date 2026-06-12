import { defineConfig } from "vitest/config";

import { silenceSourcemapWarnings } from "../../vitest.logger";

export default defineConfig({
  plugins: [silenceSourcemapWarnings()],
  test: {
    name: "content-extractor",
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
