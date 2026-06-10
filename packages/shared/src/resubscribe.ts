import { inArray } from "drizzle-orm";
import { chunk, whereInChunkSize } from "./batching";
import type { Db } from "./db";
import { feeds } from "./db";

/**
 * Resubscribe (#14, #42, ADR 0010) : inverse d'Unsubscribe. Réabonner un Feed
 * désabonné efface `unsubscribed_at` et **réinitialise toute sa santé** — on
 * efface les validateurs de GET conditionnel (etag/last_modified), sinon
 * l'origine répondrait 304 et le re-backfill n'insérerait rien alors que les
 * Articles non-Saved ont justement été purgés — ainsi que l'état de santé/polling
 * (échecs consécutifs, erreurs, échéance), pour repartir d'un fetch complet.
 *
 * L'invariant `RESUBSCRIBE_RESET` est **possédé par ce module** (non exporté) :
 * toute colonne de santé ajoutée au schéma `feeds` se réinitialise ici et se
 * propage à tous les chemins de réabonnement (ré-abonnement direct `feeds.ts`,
 * import OPML `opml.ts`) sans qu'aucun appelant ait à la connaître.
 *
 * Le module ne fait **pas** l'ingestion : le re-backfill est synchrone pour le
 * ré-abonnement direct (POST /feeds) et déféré à la Queue pour l'import OPML —
 * cette décision appartient à l'appelant.
 */
const RESUBSCRIBE_RESET = {
  unsubscribed_at: null,
  next_check_at: null,
  etag: null,
  last_modified: null,
  consecutive_failures: 0,
  last_error: null,
  last_error_at: null,
} as const;

// Taille de lot d'un `UPDATE … WHERE id IN (…)` : on réserve une variable liée
// par colonne du reset, plus 1 pour le `folder_id` éventuel et 1 de marge ; le
// reste de la limite D1 sert aux ids. Dérivée du nombre **réel** de colonnes
// posées, elle s'ajuste si l'invariant grossit, au lieu d'un nombre magique qui
// dépasserait la limite silencieusement.
const RESET_COLUMNS = Object.keys(RESUBSCRIBE_RESET).length;
const RESUBSCRIBE_UPDATE_CHUNK = whereInChunkSize(RESET_COLUMNS + 2);

/** Options de réabonnement. */
export interface ResubscribeOptions {
  /**
   * Folder cible : fourni → le Feed y est (ré)assigné ; absent → son
   * rattachement existant est conservé (on ne désassigne pas sans raison).
   */
  folderId?: string;
}

/**
 * Réabonne un lot de Feeds désabonnés (#42) : UPDATE groupés respectant la
 * limite D1 de variables liées (la dernière tranche peut être partielle). Les
 * appelants qui visent des Folders cibles distincts (import OPML) appellent une
 * fois par groupe pour ne pas mélanger les rattachements. No-op sur liste vide.
 */
export async function resubscribeFeeds(
  db: Db,
  feedIds: string[],
  opts: ResubscribeOptions = {},
): Promise<void> {
  if (feedIds.length === 0) return;
  const set =
    opts.folderId !== undefined
      ? { ...RESUBSCRIBE_RESET, folder_id: opts.folderId }
      : RESUBSCRIBE_RESET;
  for (const group of chunk(feedIds, RESUBSCRIBE_UPDATE_CHUNK)) {
    await db.update(feeds).set(set).where(inArray(feeds.id, group));
  }
}

/** Sucre unitaire de {@link resubscribeFeeds} pour un seul Feed. */
export async function resubscribeFeed(db: Db, feedId: string): Promise<void> {
  await resubscribeFeeds(db, [feedId]);
}
