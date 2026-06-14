import { useRegisterSW } from "virtual:pwa-register/react";
import { useEffect } from "react";
import { requestPersistentStorage } from "../lib/pwa";
import { UpdateBanner } from "./UpdateBanner";

/**
 * Enregistrement du service worker + câblage du bandeau de MAJ et de la
 * demande de stockage persistant (#76, ADR 0018).
 *
 * - `useRegisterSW` (vite-plugin-pwa) enregistre le SW et expose `needRefresh`
 *   (nouvelle version precachée en attente) + `updateServiceWorker(true)` qui
 *   active le SW en attente et recharge.
 * - `requestPersistentStorage()` est demandé une fois au montage (best-effort).
 *
 * **Inerte sous test/jsdom** : ce composant importe le module virtuel
 * `virtual:pwa-register/react` (résolu uniquement par le build Vite), il n'est
 * donc monté que dans `main.tsx`, sous garde `import.meta.env.PROD`, jamais
 * importé par les tests. La logique testable (bandeau, storage) vit dans des
 * modules dédiés (`UpdateBanner.tsx`, `lib/pwa.ts`) couverts en isolation.
 */
export function RegisterSW() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(swUrl) {
      // Log discret : confirme l'enregistrement effectif du SW à l'URL attendue.
      if (import.meta.env.DEV) console.info(`[pwa] SW enregistré : ${swUrl}`);
    },
  });

  useEffect(() => {
    void requestPersistentStorage();
  }, []);

  return (
    <UpdateBanner
      needRefresh={needRefresh}
      onUpdate={() => updateServiceWorker(true)}
    />
  );
}
