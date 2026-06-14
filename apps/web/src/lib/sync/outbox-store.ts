import type { MarkReadRequest } from "@boreas/api-contracts";
import type { OutboxEntry, OutboxEntryInput, ReplicaDb } from "./replica-store";

/**
 * Sync montante (#74, ADR 0018) : helpers de l'**outbox** IndexedDB et écritures
 * optimistes du réplica. C'est le **chemin d'écriture hors-ligne** : une bascule
 * Read/Saved ou un « tout marquer lu » est (1) appliqué optimistement au réplica
 * — pour que la vue non-lus local-first reflète l'action **instantanément**,
 * même hors-ligne —, puis (2) empilé dans l'outbox, **flushée à la reconnexion**
 * via `flushOutbox` (branché dans `runSync`, push-avant-pull).
 *
 * Conflits = **last-write-wins** booléen (mono-utilisateur) : tant qu'une entrée
 * n'est pas ackée, `applyDelta` ignore les upserts/tombstones descendants de
 * l'article concerné (cf. `pendingArticleIds`).
 */

export type { OutboxEntry, OutboxEntryInput } from "./replica-store";
// Re-export : `pendingArticleIds` vit dans `replica-store` (besoin du schéma typé)
// mais appartient conceptuellement à l'outbox.
export { pendingArticleIds } from "./replica-store";

// --- Helpers de l'outbox (FIFO) ---

/** Empile une mutation dans l'outbox ; `seq` est attribué par le store. */
export async function enqueueOutbox(
  db: ReplicaDb,
  entry: OutboxEntryInput,
): Promise<void> {
  // `seq` est auto-incrémenté : on n'a pas à le fournir (cast pour le keyPath).
  await db.add("outbox", entry as OutboxEntry);
}

/** Lit toutes les entrées de l'outbox, dans l'ordre FIFO (par `seq` croissant). */
export async function readOutbox(db: ReplicaDb): Promise<OutboxEntry[]> {
  return db.getAll("outbox");
}

/** Supprime (ack) une entrée de l'outbox par son `seq`. */
export async function deleteOutboxEntry(
  db: ReplicaDb,
  seq: number,
): Promise<void> {
  await db.delete("outbox", seq);
}

// --- Écritures optimistes du réplica ---

/**
 * Pose optimistement un champ booléen (`read`/`saved`) d'un article du réplica,
 * dans une transaction unique. No-op si l'article n'est pas répliqué (cas d'une
 * vue encore servie par l'API en #73, où l'article peut ne pas être dans le
 * réplica) : le cache react-query et l'outbox suffisent alors.
 */
export async function setArticleFieldInReplica(
  db: ReplicaDb,
  id: string,
  field: "read" | "saved",
  value: boolean,
): Promise<void> {
  const tx = db.transaction("articles", "readwrite");
  const store = tx.objectStore("articles");
  const current = await store.get(id);
  if (current) await store.put({ ...current, [field]: value });
  await tx.done;
}

/**
 * Marque optimistement `read=true` sur les articles d'une portée
 * (global/feed/folder), dans une transaction unique. Pour `folder`, on résout
 * d'abord les feeds rattachés au dossier (store `feeds`) pour savoir quels
 * articles marquer — symétrie du `mark-read` serveur par portée.
 */
export async function markReadInReplica(
  db: ReplicaDb,
  scope: MarkReadRequest,
): Promise<void> {
  // Pour la portée folder, on a besoin de l'ensemble des feeds du dossier.
  const feedIds =
    scope.scope === "folder"
      ? new Set(
          (await db.getAll("feeds"))
            .filter((f) => f.folderId === scope.folderId)
            .map((f) => f.id),
        )
      : null;

  const tx = db.transaction("articles", "readwrite");
  const store = tx.objectStore("articles");
  let cursor = await store.openCursor();
  while (cursor) {
    const a = cursor.value;
    const inScope =
      scope.scope === "global"
        ? true
        : scope.scope === "feed"
          ? a.feedId === scope.feedId
          : (feedIds?.has(a.feedId) ?? false);
    if (inScope && !a.read) await cursor.update({ ...a, read: true });
    cursor = await cursor.continue();
  }
  await tx.done;
}

// --- Flush (push montant) ---

/**
 * Transport de push d'une entrée d'outbox : exécute la requête API correspondante
 * (`PATCH /api/articles/:id` pour `patch`, `POST /api/articles/mark-read` pour
 * `markRead`). Résout au succès, rejette sur erreur (réseau ou `ApiError`).
 */
export type PushOutbox = (entry: OutboxEntry) => Promise<void>;

/**
 * Pousse l'outbox vers l'API dans l'ordre FIFO, **avant** le pull du delta
 * (étape (1) de `runSync`, ADR 0018). Chaque entrée poussée avec succès est
 * **ackée** (supprimée) ; l'arrêt préserve toujours les entrées restantes :
 *  - **401** (session expirée) : on **arrête net** sans drop. L'erreur remonte,
 *    le guard redirige vers `/login`, et l'outbox — persistante en IndexedDB —
 *    sera re-flushée après ré-auth.
 *  - **erreur réseau / autre** : on laisse l'entrée courante (et les suivantes)
 *    pour la prochaine passe, en propageant l'erreur (la sync globale échoue).
 *
 * Le rejeu se fait toujours depuis le début de l'outbox courante : les entrées
 * empilées par une mutation concurrente seront prises à la passe suivante.
 */
export async function flushOutbox(
  db: ReplicaDb,
  push: PushOutbox,
): Promise<void> {
  const entries = await readOutbox(db);
  for (const entry of entries) {
    await push(entry); // lève sur 401/réseau → on s'arrête, l'entrée reste.
    await deleteOutboxEntry(db, entry.seq); // ack : entrée poussée → supprimée.
  }
}
