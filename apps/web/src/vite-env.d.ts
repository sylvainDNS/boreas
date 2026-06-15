/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />
/// <reference types="vite-plugin-pwa/react" />
/// <reference types="vite-plugin-pwa/info" />

interface ImportMetaEnv {
  /** Clé publique VAPID (point P-256 brut, base64url) — `applicationServerKey` du Web Push (#79). */
  readonly VITE_VAPID_PUBLIC_KEY: string;
}
