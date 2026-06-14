/// <reference lib="webworker" />
import { clientsClaim } from "workbox-core";
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";

/**
 * Service worker custom de Boréas (#76, ADR 0018) — mode `injectManifest` :
 * Workbox gère le **precache du shell** + le **versioning**, on écrit la logique
 * applicative. Pour CE ticket, le SW assure le **boot hors-ligne** :
 *
 *  1. **Precache du shell** : `self.__WB_MANIFEST` (injecté au build par
 *     vite-plugin-pwa) liste les assets du shell (HTML, JS, CSS, icônes…).
 *  2. **Navigation fallback** : toute navigation (mode `navigate`) est servie
 *     depuis `index.html` precaché → l'app boote même réseau coupé. Le routage
 *     applicatif (TanStack Router) prend ensuite le relais côté client, et l'UI
 *     lit le réplica IndexedDB (local-first, #72).
 *  3. **Flux de MAJ** : `skipWaiting` sur message du client → la nouvelle
 *     version precachée s'active à la demande (bandeau de MAJ, cf.
 *     `register-sw.tsx`).
 *
 * Le **moteur de sync** (#72) reste le seul à parler au backend : le SW ne
 * duplique aucune logique de données.
 */

// Le contexte d'un SW n'est pas `Window` ; on type `self` en conséquence.
declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

// 1. Precache du shell + nettoyage des révisions précédentes au versioning.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Le SW réclame les clients dès son activation. Indispensable au flux de MAJ :
// après `skipWaiting`, le nouveau SW prend le contrôle de l'onglet courant, ce qui
// déclenche `controllerchange` → `useRegisterSW` recharge la page (sans ce claim,
// le bandeau « Mettre à jour » resterait sans effet). Garantit aussi que le SW
// contrôle la page dès la première visite, pour un boot hors-ligne fiable ensuite.
clientsClaim();

// 2. Boot hors-ligne : les navigations retombent sur l'index.html precaché
//    (SPA). On exclut les requêtes /api/* (gérées par le réseau / le moteur de
//    sync, jamais par ce fallback de shell).
const navigationHandler = createHandlerBoundToURL("index.html");
registerRoute(
  new NavigationRoute(navigationHandler, {
    denylist: [/^\/api\//],
  }),
);

// 3. Flux de MAJ : on n'auto-skip pas (sinon l'utilisateur perdrait l'onglet
//    courant sans prévenir). Le client demande explicitement l'activation via
//    `updateServiceWorker(true)` (bandeau), qui poste ce message.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
