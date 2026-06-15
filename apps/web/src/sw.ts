/// <reference lib="webworker" />
import { CacheableResponsePlugin } from "workbox-cacheable-response";
import { clientsClaim } from "workbox-core";
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { CacheFirst } from "workbox-strategies";
import { PERIODIC_SYNC_TAG } from "./lib/pwa";
import { IMAGE_CACHE } from "./lib/sync/image-cache";

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
 *  3. **Images hors-ligne** (#77) : le proxy `/api/img` est servi **cache-first**
 *     depuis un Cache Storage dédié (`IMAGE_CACHE`), pré-chauffé par le moteur de
 *     sync. Hit → servi sans réseau (lecture hors-ligne) ; miss en ligne → réseau
 *     puis mise en cache.
 *  4. **Flux de MAJ** : `skipWaiting` sur message du client → la nouvelle
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

// 2. Images hors-ligne (#77, ADR 0018) : le proxy d'images `/api/img` est servi
//    **cache-first** depuis un cache dédié (`IMAGE_CACHE`), pré-chauffé par le
//    moteur de sync en parsant le HTML des articles du corpus offline. Le
//    cache-first est sûr car les URLs `/api/img?u=…&sig=…` sont **déterministes
//    et stables** (signature HMAC sur `u`, ADR 0009) : une même image a toujours
//    la même clé, et le proxy renvoie un objet immuable (`Cache-Control immutable`).
//    On ne matche QUE `/api/img` (pas tout `/api/`, qui doit aller au réseau) ; la
//    requête est **same-origin** (SPA et API partagent l'origine via Pages
//    Functions, ADR 0008), d'où le match par `url.pathname`.
//
//    Plugins : `CacheableResponsePlugin` n'autorise en cache que les statuts 0
//    (réponse opaque) et 200 — une 502 du proxy (image source indisponible) n'est
//    donc **jamais** figée. La GC des images (comptage de références, éviction)
//    est laissée à #81 ; on ne borne pas le cache ici (cohérent avec « contenu
//    sans plafond » du corpus offline, ADR 0018).
registerRoute(
  ({ url }) => url.pathname === "/api/img",
  new CacheFirst({
    cacheName: IMAGE_CACHE,
    plugins: [new CacheableResponsePlugin({ statuses: [0, 200] })],
  }),
);

// 3. Boot hors-ligne : les navigations retombent sur l'index.html precaché
//    (SPA). On exclut les requêtes /api/* (gérées par le réseau / le moteur de
//    sync, jamais par ce fallback de shell).
const navigationHandler = createHandlerBoundToURL("index.html");
registerRoute(
  new NavigationRoute(navigationHandler, {
    denylist: [/^\/api\//],
  }),
);

// 4. Flux de MAJ : on n'auto-skip pas (sinon l'utilisateur perdrait l'onglet
//    courant sans prévenir). Le client demande explicitement l'activation via
//    `updateServiceWorker(true)` (bandeau), qui poste ce message.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

// 5. Periodic Background Sync (#81, ADR 0018) — **best-effort, filet de secours**.
//    Enregistré page-context (`register-sw.tsx`, gardé support+permission). Quand
//    Chrome réveille le SW pour notre tag, on **réveille les clients ouverts**
//    (`postMessage`) plutôt que de **dupliquer le moteur de sync** ici : la sync
//    complète (push outbox → pull delta → contenu/images, IndexedDB) vit en
//    contexte page (`syncReplica`/`runSync`) et ne doit exister qu'à un seul
//    endroit (ADR 0018 : « le SW ne duplique aucune logique de données »).
//
//    **Limites assumées et documentées** :
//      - si aucun client n'est ouvert, ce handler ne synchronise rien de neuf
//        (le pull complet reste page-context à la réouverture) — le periodicsync
//        ne sert qu'à rafraîchir un onglet déjà ouvert au réveil ;
//      - **iOS** ne supporte pas du tout cette API (jamais déclenché) ;
//      - la fréquence réelle est à la discrétion du navigateur (gating Chrome).
self.addEventListener("periodicsync", (event) => {
  const periodicEvent = event as ExtendableEvent & { tag?: string };
  // Tag importé de `lib/pwa` (source unique) : il DOIT coïncider avec celui passé
  // à `periodicSync.register` côté page, sinon ce handler ne matcherait jamais.
  if (periodicEvent.tag !== PERIODIC_SYNC_TAG) return;
  periodicEvent.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          client.postMessage({ type: "PERIODIC_SYNC" });
        }
      }),
  );
});
