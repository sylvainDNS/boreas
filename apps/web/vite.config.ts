import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    // Le plugin TanStack Router doit précéder @vitejs/plugin-react.
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    tailwindcss(),
    react(),
  ],
  server: {
    // Proxy /api/* vers le Worker API local (même origine, zéro CORS — ADR 0008).
    // En prod, le routage est assuré par la Pages Function (service binding) — câblé au #3.
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
});
