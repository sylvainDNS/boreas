import { useRegisterSW } from "virtual:pwa-register/react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { registerPeriodicSync, requestPersistentStorage } from "../lib/pwa";
import { syncReplica } from "../lib/sync/replica";
import { invalidateOfflineViews } from "../lib/sync/use-replica-sync";
import { UpdateBanner } from "./UpdateBanner";

/**
 * Enregistrement du service worker + câblage du bandeau de MAJ, de la demande de
 * stockage persistant (#76) et du Periodic Background Sync (#81, ADR 0018).
 *
 * - `useRegisterSW` (vite-plugin-pwa) enregistre le SW et expose `needRefresh`
 *   (nouvelle version precachée en attente) + `updateServiceWorker(true)` qui
 *   active le SW en attente et recharge ; `onRegisteredSW` reçoit la
 *   `ServiceWorkerRegistration` une fois prête.
 * - `requestPersistentStorage()` est demandé une fois au montage (best-effort).
 * - `registerPeriodicSync(registration)` est tenté à l'enregistrement du SW
 *   (best-effort, gardé support+permission ; cf. `lib/pwa.ts`). Jamais bloquant.
 *
 * **Inerte sous test/jsdom** : ce composant importe le module virtuel
 * `virtual:pwa-register/react` (résolu uniquement par le build Vite), il n'est
 * donc monté que dans `main.tsx`, sous garde `import.meta.env.PROD`, jamais
 * importé par les tests. La logique testable (bandeau, storage, periodic sync)
 * vit dans des modules dédiés (`UpdateBanner.tsx`, `lib/pwa.ts`) couverts en
 * isolation.
 */
export function RegisterSW() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(swUrl, registration) {
      // Log discret : confirme l'enregistrement effectif du SW à l'URL attendue.
      if (import.meta.env.DEV) console.info(`[pwa] SW enregistré : ${swUrl}`);
      // Periodic Background Sync (#81), best-effort : on tente une fois le SW
      // enregistré, sans bloquer ni propager d'erreur (gardes dans `lib/pwa.ts`).
      if (registration) void registerPeriodicSync(registration);
    },
  });

  const queryClient = useQueryClient();

  useEffect(() => {
    void requestPersistentStorage();
  }, []);

  // Filet du Periodic Background Sync (#81) : quand le SW est réveillé par le
  // navigateur, il `postMessage({type:'PERIODIC_SYNC'})` aux clients ouverts.
  // Un onglet ouvert déclenche alors une passe de sync page-context (le seul
  // endroit où vit le moteur), **puis invalide les vues** (comme `useReplicaSync`)
  // pour que listes/compteurs/recherche/badge outbox reflètent la mise à jour —
  // sans cette invalidation, le réplica serait à jour mais l'UI figée. Best-effort.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== "PERIODIC_SYNC") return;
      void syncReplica()
        .then(() => invalidateOfflineViews(queryClient))
        .catch(() => {});
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () =>
      navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [queryClient]);

  return (
    <UpdateBanner
      needRefresh={needRefresh}
      onUpdate={() => updateServiceWorker(true)}
    />
  );
}
