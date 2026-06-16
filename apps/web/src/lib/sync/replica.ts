import { deleteReplica, openReplica, type ReplicaDb } from "./replica-store";
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
 * Trappe de secours manuelle (Réglages) : ferme la connexion, supprime
 * **entièrement** le réplica, puis coupe la dédup de sync en vol. Après coup,
 * `getReplica()` rouvre une base vierge (migrations rejouées) et `syncReplica()`
 * repart d'un `since=0` (curseur effacé) — soit l'état cold-start déjà
 * fonctionnel. Jette l'`outbox` au passage (mutations Read/Saved non poussées) :
 * assumé, c'est le but d'une réinitialisation quand la sync est coincée.
 *
 * On attend l'**ouverture** pour récupérer le handle et le `close()` **avant** de
 * supprimer — ce qui évite le `onblocked` de `deleteDatabase` dans le cas normal.
 * On n'attend volontairement **pas** une passe de sync en vol (elle peut être
 * justement ce qui est coincé) : sa connexion fermée la fera échouer sans bruit,
 * et `syncReplica` ne la réutilisera pas (`inFlight` remis à null).
 */
export async function wipeReplica(): Promise<void> {
  if (replicaPromise) {
    const db = await replicaPromise.catch(() => null);
    db?.close();
  }
  replicaPromise = null;
  inFlight = null;
  await deleteReplica();
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
  const pass = (async () => {
    const db = await getReplica();
    await runSync(db, pullSyncDelta, pushOutboxEntry, pullArticleContent);
  })().finally(() => {
    // Ne libère `inFlight` que si on est **encore** la passe courante :
    // `wipeReplica`/`resetReplicaSingleton` ont pu remettre `inFlight` à null puis
    // une nouvelle passe démarrer pendant que celle-ci s'achevait — la nuller
    // aveuglément écraserait cette passe plus récente et casserait la dédup.
    if (inFlight === pass) inFlight = null;
  });
  inFlight = pass;
  return pass;
}
