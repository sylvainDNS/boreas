import { inArray } from "drizzle-orm";
import { chunk, whereInChunkSize } from "./batching";
import type { Db } from "./db";
import { feeds } from "./db";
import { nowEpochMs } from "./timestamp";

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
// par colonne du reset, plus `updated_at` (#69), plus 1 pour le `folder_id`
// éventuel, 1 pour le `rank` éventuel (#117) et 1 de marge ; le reste de la
// limite D1 sert aux ids. Dérivée du nombre **réel** de colonnes posées, elle
// s'ajuste si l'invariant grossit, au lieu d'un nombre magique qui dépasserait
// la limite silencieusement.
const RESET_COLUMNS = Object.keys(RESUBSCRIBE_RESET).length;
const RESUBSCRIBE_UPDATE_CHUNK = whereInChunkSize(RESET_COLUMNS + 4);

/** Options de réabonnement. */
export interface ResubscribeOptions {
  /**
   * Folder cible : fourni → le Feed y est (ré)assigné ; absent → son
   * rattachement existant est conservé (on ne désassigne pas sans raison).
   */
  folderId?: string;
  /**
   * Rang cible (#117) : fourni → écrit dans le même UPDATE atomique que la
   * réassignation, pour poser le Feed réabonné en fin du conteneur cible
   * (Option A, #110). Absent → le rang d'origine est conservé. N'a de sens
   * qu'accompagné de `folderId` (réassignation), mais reste indépendant.
   */
  rank?: string;
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
  // Le réabonnement est une mutation de domaine (le Feed redevient actif) :
  // bump `updated_at` (#69, ADR 0018) pour que le delta sync le re-pousse, comme
  // le désabonnement. Calculé ici (pas dans la const statique, qui figerait
  // l'horodatage à l'import) ; tout le lot partage la même valeur.
  const set: typeof RESUBSCRIBE_RESET & {
    updated_at: number;
    folder_id?: string | null;
    rank?: string;
  } = { ...RESUBSCRIBE_RESET, updated_at: nowEpochMs() };
  if (opts.folderId !== undefined) set.folder_id = opts.folderId;
  if (opts.rank !== undefined) set.rank = opts.rank;
  for (const group of chunk(feedIds, RESUBSCRIBE_UPDATE_CHUNK)) {
    await db.update(feeds).set(set).where(inArray(feeds.id, group));
  }
}

/** Sucre unitaire de {@link resubscribeFeeds} pour un seul Feed. */
export async function resubscribeFeed(
  db: Db,
  feedId: string,
  opts: ResubscribeOptions = {},
): Promise<void> {
  await resubscribeFeeds(db, [feedId], opts);
}
