/**
 * Demande au navigateur de marquer le stockage comme **persistant**
 * (`navigator.storage.persist()`, #76, ADR 0018), pour limiter l'éviction du
 * réplica IndexedDB et du Cache Storage sous pression disque.
 *
 * **Best-effort** : ne lève jamais, no-op silencieux si l'API est absente
 * (jsdom de test, navigateurs anciens). On ne redemande pas si la persistance
 * est déjà accordée. Renvoie l'état final (persistant ou non).
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    const storage = navigator.storage;
    if (!storage?.persist || !storage.persisted) return false;
    if (await storage.persisted()) return true;
    return await storage.persist();
  } catch {
    return false;
  }
}

/** Tag du Periodic Background Sync de Boréas (partagé page-context ↔ SW). */
export const PERIODIC_SYNC_TAG = "boreas-sync";

/**
 * Intervalle minimal demandé au Periodic Background Sync (#81, ADR 0018). Le
 * navigateur (Chrome) traite cette valeur comme une **borne basse indicative** :
 * la fréquence réelle dépend de l'engagement avec la PWA et de l'état réseau/
 * batterie. ~6 h est un filet raisonnable (le gros de la sync reste page-context
 * à la réouverture).
 */
const PERIODIC_SYNC_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Forme **minimale** des API non-standard du Periodic Background Sync, typée
 * prudemment (absentes sous jsdom et sur Safari/Firefox) : on ne dépend que de
 * `periodicSync.register` et du `tags()` de diagnostic.
 */
interface PeriodicSyncManagerLike {
  register(tag: string, options?: { minInterval?: number }): Promise<void>;
  getTags?(): Promise<string[]>;
}

/**
 * Enregistre le **Periodic Background Sync** (#81, ADR 0018), best-effort et
 * **jamais bloquant**. Gardé par :
 *  - le **support** : `'periodicSync' in registration` (absent partout sauf
 *    Chrome/Android installé) ;
 *  - la **permission** : `navigator.permissions.query({name:
 *    'periodic-background-sync'})` doit être `granted` (sinon `register` lèverait).
 *
 * Toute absence d'API ou tout rejet est **avalé** : l'enregistrement est un
 * simple « filet » (le navigateur réveille le SW au mieux). Le handler
 * `periodicsync` du SW ne fait qu'un best-effort — **le gros de la sync reste
 * page-context** à la réouverture (limite documentée, cf. ADR 0018 ; iOS ne
 * supporte pas du tout cette API). Renvoie `true` si l'enregistrement a abouti.
 */
export async function registerPeriodicSync(
  registration: ServiceWorkerRegistration,
): Promise<boolean> {
  try {
    if (!("periodicSync" in registration)) return false;

    // Permission requise : sans `granted`, `register` lèverait. `permissions`
    // ou ce `name` peut être absent → on avale et on renvoie false.
    const status = await navigator.permissions
      .query({
        // `name` non-standard : pas dans le type `PermissionName` du DOM lib.
        name: "periodic-background-sync" as PermissionName,
      })
      .catch(() => null);
    if (status?.state !== "granted") return false;

    const periodicSync = (
      registration as ServiceWorkerRegistration & {
        periodicSync: PeriodicSyncManagerLike;
      }
    ).periodicSync;
    await periodicSync.register(PERIODIC_SYNC_TAG, {
      minInterval: PERIODIC_SYNC_MIN_INTERVAL_MS,
    });
    return true;
  } catch {
    // Best-effort : permission refusée, quota, API partielle → on n'insiste pas.
    return false;
  }
}
