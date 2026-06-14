import { z } from "zod";
import { articleListItemSchema } from "./articles";
import { feedSchema } from "./feeds";
import { folderSchema } from "./folders";

/**
 * Delta sync descendant (#72, ADR 0018) : `GET /api/sync?since=<epoch-ms>`.
 *
 * Le moteur de sync du réplica local appelle cet endpoint pour rapatrier, depuis
 * un curseur `since`, **tout** ce qui a muté côté serveur : upserts (lignes dont
 * `updated_at > since`) et tombstones (suppressions dont `deleted_at > since`).
 * `since` absent/0 = **sync initiale complète**, paginée en keyset. La réponse
 * porte un **curseur** (borne haute des horodatages servis) à repasser au pull
 * suivant, et un drapeau `complete` indiquant si la page épuise le delta.
 *
 * Le **contenu HTML** et les **images** ne transitent PAS ici (#75/#77) : seules
 * les métadonnées descendent. On réutilise les schémas d'items existants
 * (`articleListItem`/`feed`/`folder`) pour que le réplica stocke exactement la
 * forme déjà connue de l'UI, sans type miroir à maintenir.
 */

/** Article métadonnée répliquée : forme identique à l'item de liste (`GET /api/articles`). */
export const syncArticleSchema = articleListItemSchema;
export type SyncArticle = z.infer<typeof syncArticleSchema>;

/**
 * Feed répliqué : item de `GET /api/feeds` (`feedSchema`) + un marqueur
 * `unsubscribed`. Le réplica reçoit **tous** les feeds (corpus complet, ADR
 * 0018), y compris les désabonnés que `GET /api/feeds` masque ; le repository
 * local s'en sert pour exclure leurs articles de la river non-lus, exactement
 * comme l'API (le wire de `GET /api/feeds` reste, lui, inchangé).
 */
export const syncFeedSchema = feedSchema.extend({
  /** `true` si le Feed est désabonné (masqué). Absent du wire de `GET /api/feeds`. */
  unsubscribed: z.boolean(),
});
export type SyncFeed = z.infer<typeof syncFeedSchema>;

/** Folder répliqué : forme identique à l'item de `GET /api/folders`. */
export const syncFolderSchema = folderSchema;
export type SyncFolder = z.infer<typeof syncFolderSchema>;

/** Tombstone : entité supprimée à évincer du réplica. */
export const syncTombstoneSchema = z.object({
  entityType: z.enum(["article", "feed", "folder"]),
  entityId: z.string(),
});
export type SyncTombstone = z.infer<typeof syncTombstoneSchema>;

/**
 * `GET /api/sync` — page de delta.
 *
 * - `upserts` : lignes (par type) à insérer/mettre à jour dans le réplica.
 * - `tombstones` : entités à évincer du réplica.
 * - `cursor` : borne haute des horodatages servis (epoch-ms), à repasser en
 *   `since` au pull suivant ; `null` quand la page est vide (rien à avancer).
 * - `complete` : `true` quand cette page épuise le delta (plus rien à paginer) ;
 *   `false` quand il reste des pages (le client rappelle avec `cursor`).
 * - `stale` : `true` quand `since` est antérieur à la fenêtre de rétention des
 *   tombstones : le serveur ne peut plus garantir l'exhaustivité des
 *   suppressions → le client **wipe le réplica + resync complet** (`since=0`).
 *   Dans ce cas `upserts`/`tombstones` sont vides et `cursor`/`complete` ne sont
 *   pas significatifs.
 */
export const syncResponseSchema = z.object({
  upserts: z.object({
    articles: z.array(syncArticleSchema),
    feeds: z.array(syncFeedSchema),
    folders: z.array(syncFolderSchema),
  }),
  tombstones: z.array(syncTombstoneSchema),
  cursor: z.number().nullable(),
  complete: z.boolean(),
  stale: z.boolean(),
});
export type SyncResponse = z.infer<typeof syncResponseSchema>;
