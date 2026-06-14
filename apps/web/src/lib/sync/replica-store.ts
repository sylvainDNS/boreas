import type {
  MarkReadRequest,
  SyncArticle,
  SyncFeed,
  SyncFolder,
  SyncTombstone,
} from "@boreas/api-contracts";
import { type DBSchema, type IDBPDatabase, openDB } from "idb";

/**
 * Réplica local IndexedDB (#72, ADR 0018) : la copie locale des métadonnées que
 * l'UI lit **toujours** (local-first), alimentée par le moteur de sync. Seul le
 * moteur de sync écrit ici via `applyDelta` ; les vues lisent via le repository
 * (`articles.ts`). Le contenu HTML et les images n'y vivent PAS (#75/#77).
 */

/** Nom de la base IndexedDB du réplica. */
export const REPLICA_DB_NAME = "boreas-replica";

/**
 * Version du schéma d'objets (à incrémenter pour toute migration de stores).
 * v2 (#74) : ajout du store `outbox` (sync montante). Les stores existants sont
 * inchangés — la migration ne fait que créer le nouveau store.
 */
const REPLICA_DB_VERSION = 2;

/** Clé du curseur de sync (`since`) dans le store `meta`. */
const SYNC_CURSOR_KEY = "syncCursor";

/**
 * Enregistrement article du réplica = item wire de liste + une clé de tri
 * dérivée. `sortKey = publishedAt ?? fetchedAt` matérialise le `coalesce` SQL de
 * l'API (ADR 0015) pour que le repository pagine en keyset par un **index**
 * (`articles.sortKey`) sans charger tout le corpus en mémoire. Stockée à l'écriture
 * plutôt que recalculée à la lecture pour pouvoir l'indexer.
 */
export interface ReplicaArticle extends SyncArticle {
  /** `publishedAt ?? fetchedAt` : clé de tri indexée, miroir du coalesce SQL. */
  sortKey: string;
}

/**
 * Entrée d'outbox (#74, sync montante, ADR 0018) : une mutation de lecture
 * appliquée optimistement au réplica et en attente d'être poussée vers l'API.
 * Discriminée sur `kind` :
 *  - `patch` : bascule Read/Saved d'**un** article (`PATCH /api/articles/:id`) ;
 *  - `markRead` : « tout marquer lu » sur une portée (`POST /api/articles/mark-read`),
 *    rejoué en **une seule** requête de scope (pas N patchs).
 * `seq` est la clé auto-incrémentée du store, qui matérialise l'ordre **FIFO** de
 * rejeu (push-avant-pull, dans l'ordre d'empilement).
 */
export type OutboxEntry = OutboxPatch | OutboxMarkRead;

/** Mutation à enfiler (sans `seq`, attribué par le store à l'insertion). */
export type OutboxEntryInput =
  | Omit<OutboxPatch, "seq">
  | Omit<OutboxMarkRead, "seq">;

interface OutboxPatch {
  seq: number;
  kind: "patch";
  articleId: string;
  field: "read" | "saved";
  value: boolean;
}

interface OutboxMarkRead {
  seq: number;
  kind: "markRead";
  scope: MarkReadRequest;
}

/**
 * Schéma typé du réplica. `meta` porte le curseur de sync (et, plus tard,
 * d'autres scalaires). Le store `outbox` (#74, sync montante) empile les
 * mutations locales en attente de push, clé `seq` auto-incrémentée (ordre FIFO).
 */
interface ReplicaSchema extends DBSchema {
  articles: {
    key: string;
    value: ReplicaArticle;
    indexes: { sortKey: string };
  };
  feeds: { key: string; value: SyncFeed };
  folders: { key: string; value: SyncFolder };
  meta: { key: string; value: { key: string; value: unknown } };
  outbox: { key: number; value: OutboxEntry };
}

/** Handle de base typé du réplica. */
export type ReplicaDb = IDBPDatabase<ReplicaSchema>;

/** Délta descendant appliqué au réplica (sous-ensemble de `SyncResponse`). */
export interface ReplicaDelta {
  upserts: {
    articles: SyncArticle[];
    feeds: SyncFeed[];
    folders: SyncFolder[];
  };
  tombstones: SyncTombstone[];
}

/** Calcule la clé de tri d'un article (miroir du coalesce SQL, ADR 0015). */
function sortKeyOf(article: SyncArticle): string {
  return article.publishedAt ?? article.fetchedAt;
}

/**
 * Ouvre (et crée/migre au besoin) la base du réplica. Migrations idempotentes
 * par palier de version (`oldVersion`) : chaque store n'est créé qu'une fois,
 * sans toucher aux données des stores existants lors d'un bump.
 */
export function openReplica(): Promise<ReplicaDb> {
  return openDB<ReplicaSchema>(REPLICA_DB_NAME, REPLICA_DB_VERSION, {
    upgrade(db, oldVersion) {
      // v1 : corpus de lecture (réplica descendant, #72).
      if (oldVersion < 1) {
        const articlesStore = db.createObjectStore("articles", {
          keyPath: "id",
        });
        // Index de la pagination keyset de la river non-lus : tri par sortKey desc.
        articlesStore.createIndex("sortKey", "sortKey");
        db.createObjectStore("feeds", { keyPath: "id" });
        db.createObjectStore("folders", { keyPath: "id" });
        db.createObjectStore("meta", { keyPath: "key" });
      }
      // v2 : outbox de la sync montante (#74). Clé `seq` auto-incrémentée pour
      // un rejeu FIFO ; on ne touche pas aux stores de lecture existants.
      if (oldVersion < 2) {
        db.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true });
      }
    },
  });
}

/** Supprime entièrement le réplica (wipe avant resync complet sur curseur périmé). */
export function deleteReplica(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(REPLICA_DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    // `onblocked` : une autre connexion tient la base. On résout quand même —
    // la suppression aboutira à la fermeture de l'autre connexion.
    req.onblocked = () => resolve();
  });
}

/**
 * Vide tous les stores du réplica (corpus + curseur) **sans fermer la base** :
 * utilisé par le moteur de sync sur curseur périmé (wipe + resync complet),
 * quand fermer/rouvrir la base mid-sync serait plus fragile que de la vider.
 */
export async function clearReplica(db: ReplicaDb): Promise<void> {
  const tx = db.transaction(
    ["articles", "feeds", "folders", "meta"],
    "readwrite",
  );
  await Promise.all([
    tx.objectStore("articles").clear(),
    tx.objectStore("feeds").clear(),
    tx.objectStore("folders").clear(),
    tx.objectStore("meta").clear(),
  ]);
  await tx.done;
}

/** Lit le curseur de sync (`since`), ou `null` si aucune sync n'a encore eu lieu. */
export async function readSyncCursor(db: ReplicaDb): Promise<number | null> {
  const row = await db.get("meta", SYNC_CURSOR_KEY);
  return typeof row?.value === "number" ? row.value : null;
}

/** Persiste le curseur de sync (`since`) pour le prochain pull. */
export async function writeSyncCursor(
  db: ReplicaDb,
  cursor: number,
): Promise<void> {
  await db.put("meta", { key: SYNC_CURSOR_KEY, value: cursor });
}

/**
 * Applique un delta descendant au réplica dans **une seule transaction** couvrant
 * les trois stores : upserts (insert/update par id) puis tombstones (évictions).
 * Idempotent — réappliquer le même delta laisse le réplica identique (upsert par
 * clé, delete sans effet si absent), ce qui rend les pulls paginés/rejoués sûrs.
 *
 * **Protection des mutations non-ackées (#74, ADR 0018)** : tant qu'un article a
 * une entrée dans l'outbox (mutation locale pas encore poussée), les upserts ET
 * tombstones descendants le concernant sont **ignorés** — un état serveur en
 * retard ne « ressuscite » pas l'article ni n'annule l'optimisme local (LWW
 * booléen, mono-utilisateur). Les feeds/folders ne sont jamais protégés (l'outbox
 * ne porte que des mutations d'articles).
 *
 * Le set des ids en attente est lu **dans la même transaction** que les écritures
 * (le store `outbox` est inclus dans la tx) : aucune mutation concurrente ne peut
 * s'insérer entre la lecture de l'outbox et l'application du delta, ce qui
 * fermerait sinon une fenêtre où un upsert écraserait une entrée tout juste empilée.
 */
export async function applyDelta(
  db: ReplicaDb,
  delta: ReplicaDelta,
): Promise<void> {
  const tx = db.transaction(
    ["articles", "feeds", "folders", "outbox"],
    "readwrite",
  );
  const articlesStore = tx.objectStore("articles");
  const feedsStore = tx.objectStore("feeds");
  const foldersStore = tx.objectStore("folders");

  // Ids d'articles avec une mutation `patch` non-ackée, lus dans LA transaction.
  const pending = new Set<string>();
  for (const entry of await tx.objectStore("outbox").getAll()) {
    if (entry.kind === "patch") pending.add(entry.articleId);
  }

  for (const a of delta.upserts.articles) {
    if (pending.has(a.id)) continue; // mutation locale non-ackée : on n'écrase pas.
    await articlesStore.put({ ...a, sortKey: sortKeyOf(a) });
  }
  for (const f of delta.upserts.feeds) await feedsStore.put(f);
  for (const f of delta.upserts.folders) await foldersStore.put(f);

  for (const t of delta.tombstones) {
    if (t.entityType === "article") {
      if (pending.has(t.entityId)) continue; // article en attente : pas d'éviction.
      await articlesStore.delete(t.entityId);
    } else if (t.entityType === "feed") await feedsStore.delete(t.entityId);
    else await foldersStore.delete(t.entityId);
  }

  await tx.done;
}

/**
 * Ensemble des `articleId` ayant une entrée `patch` en attente dans l'outbox.
 * Utilisé par `applyDelta` pour ne pas écraser une mutation locale non-ackée, et
 * par le repository de lecture si besoin. Les entrées `markRead` (portée) ne
 * désignent pas un article précis et n'entrent donc pas ici.
 */
export async function pendingArticleIds(db: ReplicaDb): Promise<Set<string>> {
  const entries = await db.getAll("outbox");
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "patch") ids.add(entry.articleId);
  }
  return ids;
}
