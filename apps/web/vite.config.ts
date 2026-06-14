import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    // Le plugin TanStack Router doit précéder @vitejs/plugin-react.
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    tailwindcss(),
    react(),
    // PWA (#76, ADR 0018) en mode `injectManifest` : Workbox gère le precache du
    // shell + le versioning, on écrit le SW custom (`src/sw.ts`) où est injecté
    // `self.__WB_MANIFEST`. Le SW assure le boot hors-ligne (precache + fallback
    // de navigation) ; les points d'extension #77 (images) / #79 (push) y sont
    // commentés.
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      // `prompt` : on ne recharge pas automatiquement, l'utilisateur déclenche la
      // MAJ via le bandeau (registerType piloté côté client par useRegisterSW).
      registerType: "prompt",
      // L'enregistrement du SW est fait manuellement dans `register-sw.tsx`
      // (gardé sous PROD), pas par un script auto-injecté.
      injectRegister: null,
      manifest: {
        name: "Boréas — lecteur RSS",
        short_name: "Boréas",
        description:
          "Lecteur RSS local-first : lecture hors-ligne, synchro à la reconnexion.",
        lang: "fr",
        // start_url + scope racine : l'app s'ouvre sur la home, sur tout le site.
        start_url: "/",
        scope: "/",
        display: "standalone",
        // Couleurs de marque (accent violet, cf. styles/app.css).
        theme_color: "#7c3aed",
        background_color: "#ffffff",
        icons: [
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
          // `any maskable` : un même asset full-bleed sert d'icône standard et
          // d'icône maskable (zone de sécurité respectée, suffit à Chrome).
          {
            src: "pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable",
          },
          { src: "icon.svg", sizes: "any", type: "image/svg+xml" },
        ],
      },
      injectManifest: {
        // On precache le shell : HTML, JS, CSS, SVG. Les PNG d'icônes sont
        // référencés par le manifest (téléchargés à l'install), pas dans le
        // precache du shell.
        globPatterns: ["**/*.{js,css,html,svg}"],
      },
      // En dev, pas de SW (évite un cache parasite pendant le développement).
      devOptions: { enabled: false },
    }),
  ],
  server: {
    // Proxy /api/* vers le Worker API local (même origine, zéro CORS — ADR 0008).
    // En prod, le routage est assuré par la Pages Function (service binding) — câblé au #3.
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
});
