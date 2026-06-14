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
