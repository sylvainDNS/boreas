import type { SyncResponse } from "@boreas/api-contracts";
import { flushOutbox, type PushOutbox } from "./outbox-store";
import {
  applyDelta,
  clearReplica,
  type ReplicaDb,
  readSyncCursor,
  writeSyncCursor,
} from "./replica-store";

/**
 * Moteur de sync (#72/#74, ADR 0018) : **seul** module à parler au backend pour
 * le réplica. Une passe **pousse l'outbox AVANT de pull** le delta
 * (push-avant-pull) : les mutations locales (Read/Saved/mark-all-read) partent en
 * premier, puis on rapatrie le delta descendant. L'UI ne lit que le réplica (pas
 * de switch online/offline).
 */

/** Fonction de transport : pull une page de delta pour un `since` donné. */
export type PullDelta = (since: number) => Promise<SyncResponse>;

/**
 * Défaut de `push` : **lève** dès qu'une entrée doit être poussée. Un push no-op
 * « réussirait » chaque entrée et `flushOutbox` la supprimerait → **perte
 * silencieuse** des mutations locales (Read/Saved/mark-all-read). Avec ce défaut,
 * un appelant qui oublie `push` échoue bruyamment au lieu de vider l'outbox sans
 * rien envoyer. L'unique appelant de prod (`replica.ts`) passe toujours
 * `pushOutboxEntry` ; les passes de pull pur ont une outbox vide → le push n'est
 * jamais invoqué, ce défaut n'est donc jamais atteint chez elles.
 */
const pushRequired: PushOutbox = () => {
  throw new Error(
    "runSync: argument `push` manquant alors que l'outbox contient des entrées à flusher",
  );
};

/**
 * Exécute une passe de sync complète :
 *  1. **push de l'outbox** (#74) : flush des mutations locales vers l'API, AVANT
 *     le pull. Sur `401`/réseau, l'erreur remonte ici sans drop d'entrée (l'outbox
 *     survit pour la passe suivante / la ré-auth) et on **n'enchaîne pas** le pull.
 *  2. pull du delta depuis le curseur persisté (`null` ⇒ `since=0`, initiale),
 *     en enchaînant les pages tant que `complete` est faux ;
 *  3. application de chaque page au réplica + avancée du curseur ;
 *  4. sur `stale` (curseur périmé), wipe du réplica + resync complet depuis 0.
 *
 * Idempotente et sûre à rejouer (déclencheurs multiples) : un échec réseau
 * remonte tel quel sans avancer le curseur au-delà de la dernière page écrite.
 */
export async function runSync(
  db: ReplicaDb,
  pull: PullDelta,
  push: PushOutbox = pushRequired,
): Promise<void> {
  // --- (1) Push de l'outbox AVANT le pull (push-avant-pull, ADR 0018) ---
  // En cas d'échec (401/réseau), `flushOutbox` propage : on ne pull pas, et les
  // entrées non-poussées restent en outbox pour la prochaine passe.
  await flushOutbox(db, push);

  // --- (2-4) Pull paginé depuis le curseur courant ---
  let since = (await readSyncCursor(db)) ?? 0;
  let alreadyWiped = false;

  while (true) {
    const page = await pull(since);

    // Curseur périmé : le serveur ne garantit plus l'exhaustivité des
    // suppressions depuis ce `since` → on repart d'une sync initiale propre.
    // `alreadyWiped` borne la récursion à un seul wipe (pas de boucle si le
    // serveur renvoyait `stale` même pour since=0, ce qu'il ne fait pas).
    if (page.stale && !alreadyWiped) {
      await clearReplica(db);
      alreadyWiped = true;
      since = 0;
      continue;
    }

    await applyDelta(db, {
      upserts: page.upserts,
      tombstones: page.tombstones,
    });

    // On n'avance le curseur que si la page en porte un (page vide ⇒ `null` ⇒
    // on garde le curseur précédent intact).
    if (page.cursor !== null) {
      await writeSyncCursor(db, page.cursor);
      since = page.cursor;
    }

    if (page.complete) return;
  }
}
