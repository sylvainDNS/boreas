import type {
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

/** Version du schéma d'objets (à incrémenter pour toute migration de stores). */
const REPLICA_DB_VERSION = 1;

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
 * Schéma typé du réplica. `meta` porte le curseur de sync (et, plus tard,
 * d'autres scalaires). Le store `outbox` (#74, sync montante) n'est PAS créé ici
 * mais le `upgrade` ci-dessous est le point d'extension prévu pour l'ajouter
 * (bump de version + `createObjectStore("outbox", …)`), sans toucher au reste.
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

/** Ouvre (et crée/migre au besoin) la base du réplica. */
export function openReplica(): Promise<ReplicaDb> {
  return openDB<ReplicaSchema>(REPLICA_DB_NAME, REPLICA_DB_VERSION, {
    upgrade(db) {
      // Point d'extension des migrations : ajouter ici un store `outbox` (#74)
      // sous un bump de `REPLICA_DB_VERSION`, sans toucher aux stores existants.
      const articlesStore = db.createObjectStore("articles", { keyPath: "id" });
      // Index de la pagination keyset de la river non-lus : tri par sortKey desc.
      articlesStore.createIndex("sortKey", "sortKey");
      db.createObjectStore("feeds", { keyPath: "id" });
      db.createObjectStore("folders", { keyPath: "id" });
      db.createObjectStore("meta", { keyPath: "key" });
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
 */
export async function applyDelta(
  db: ReplicaDb,
  delta: ReplicaDelta,
): Promise<void> {
  const tx = db.transaction(["articles", "feeds", "folders"], "readwrite");
  const articlesStore = tx.objectStore("articles");
  const feedsStore = tx.objectStore("feeds");
  const foldersStore = tx.objectStore("folders");

  for (const a of delta.upserts.articles) {
    await articlesStore.put({ ...a, sortKey: sortKeyOf(a) });
  }
  for (const f of delta.upserts.feeds) await feedsStore.put(f);
  for (const f of delta.upserts.folders) await foldersStore.put(f);

  for (const t of delta.tombstones) {
    if (t.entityType === "article") await articlesStore.delete(t.entityId);
    else if (t.entityType === "feed") await feedsStore.delete(t.entityId);
    else await foldersStore.delete(t.entityId);
  }

  await tx.done;
}
