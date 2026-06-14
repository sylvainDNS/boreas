import { openReplica, type ReplicaDb } from "./replica-store";
import { runSync } from "./sync-engine";
import {
  pullArticleContent,
  pullSyncDelta,
  pushOutboxEntry,
} from "./transport";

/**
 * Accès partagé au réplica IndexedDB (#72, ADR 0018) : une **unique** connexion
 * pour toute la SPA (repository de lecture + moteur de sync d'écriture). Ouvrir
 * la base est asynchrone ; on mémoïse la promesse pour que tous les appelants
 * partagent le même handle sans course à l'ouverture.
 */
let replicaPromise: Promise<ReplicaDb> | null = null;

/** Renvoie (en l'ouvrant à la demande) la connexion partagée au réplica. */
export function getReplica(): Promise<ReplicaDb> {
  if (!replicaPromise) replicaPromise = openReplica();
  return replicaPromise;
}

/**
 * Réinitialise le singleton (tests : isoler les bases entre cas). En prod, la
 * connexion vit pour toute la session. Ferme la connexion ouverte (sinon elle
 * bloquerait un `deleteDatabase` du cas suivant) et coupe la dédup de sync en
 * vol pour qu'un cas ne réutilise pas la passe du cas précédent.
 */
export function resetReplicaSingleton(): void {
  if (replicaPromise) {
    void replicaPromise.then((db) => db.close()).catch(() => {});
  }
  replicaPromise = null;
  inFlight = null;
}

/**
 * Exécute une passe de sync sur le réplica partagé via le transport réseau réel.
 * Sérialisée : si une sync est déjà en cours (déclencheurs concurrents focus +
 * online + intervalle), on renvoie la passe en vol plutôt que d'en lancer une
 * seconde en parallèle.
 */
let inFlight: Promise<void> | null = null;

export function syncReplica(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const db = await getReplica();
    await runSync(db, pullSyncDelta, pushOutboxEntry, pullArticleContent);
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}
