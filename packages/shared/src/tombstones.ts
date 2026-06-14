import { sql } from "drizzle-orm";
import { chunk, insertChunkSize } from "./batching";
import type { Db } from "./db";
import { tombstones } from "./db";
import { nowEpochMs } from "./timestamp";

/** Types d'entités traçables par un tombstone (#69, ADR 0018). */
export type TombstoneEntityType = "article" | "feed" | "folder";

// 3 paramètres liés par ligne (entity_type, entity_id, deleted_at) ; on en
// dérive la taille de lot pour ne jamais dépasser la limite D1 de variables
// liées, même si la purge supprime des centaines d'articles d'un coup.
const TOMBSTONE_INSERT_CHUNK = insertChunkSize(3);

/**
 * Inscrit un tombstone par entité supprimée (#69, ADR 0018), lus par le delta
 * sync (`GET /api/sync`, #72) pour propager l'éviction au réplica local. Posé
 * par la purge de rétention et les Delete destructifs (Feed/Folder), qui
 * faisaient jusqu'ici un hard-delete sans trace.
 *
 * Idempotent : `onConflictDoUpdate` sur la PK composite `(entity_type,
 * entity_id)` rafraîchit `deleted_at` à la re-suppression de la même entité (ex.
 * un id réémis), au lieu d'échouer sur le doublon. No-op sur liste vide.
 *
 * `deleted_at` (epoch-ms) est épinglé une fois par appel pour que toutes les
 * entités d'un même lot partagent l'horodatage exact (curseur de delta sync).
 */
export async function writeTombstones(
  db: Db,
  entityType: TombstoneEntityType,
  entityIds: string[],
): Promise<void> {
  if (entityIds.length === 0) return;
  const deletedAt = nowEpochMs();
  const rows = entityIds.map((entity_id) => ({
    entity_type: entityType,
    entity_id,
    deleted_at: deletedAt,
  }));
  for (const group of chunk(rows, TOMBSTONE_INSERT_CHUNK)) {
    await db
      .insert(tombstones)
      .values(group)
      .onConflictDoUpdate({
        target: [tombstones.entity_type, tombstones.entity_id],
        set: { deleted_at: sql`excluded.deleted_at` },
      });
  }
}
