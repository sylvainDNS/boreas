import type { SyncResponse } from "@boreas/api-contracts";
import {
  applyDelta,
  clearReplica,
  type ReplicaDb,
  readSyncCursor,
  writeSyncCursor,
} from "./replica-store";

/**
 * Moteur de sync descendante (#72, ADR 0018) : **seul** module à parler au
 * backend pour le réplica. Il pull le delta depuis `GET /api/sync?since=<curseur>`
 * et l'écrit dans le réplica local ; l'UI, elle, ne lit que le réplica (pas de
 * switch online/offline). La sync montante (outbox, #74) viendra se greffer
 * ici : `runSync` poussera l'outbox **avant** de pull — point d'extension laissé
 * en tête de la fonction, non implémenté ici.
 */

/** Fonction de transport : pull une page de delta pour un `since` donné. */
export type PullDelta = (since: number) => Promise<SyncResponse>;

/**
 * Exécute une passe de sync complète :
 *  1. (#74, à venir) push de l'outbox — pas encore implémenté ;
 *  2. pull du delta depuis le curseur persisté (`null` ⇒ `since=0`, initiale),
 *     en enchaînant les pages tant que `complete` est faux ;
 *  3. application de chaque page au réplica + avancée du curseur ;
 *  4. sur `stale` (curseur périmé), wipe du réplica + resync complet depuis 0.
 *
 * Idempotente et sûre à rejouer (déclencheurs multiples) : un échec réseau
 * remonte tel quel sans avancer le curseur au-delà de la dernière page écrite.
 */
export async function runSync(db: ReplicaDb, pull: PullDelta): Promise<void> {
  // --- (1) Point d'extension outbox (#74) ---
  // await flushOutbox(db, push);  // poussera les mutations locales avant le pull.

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
