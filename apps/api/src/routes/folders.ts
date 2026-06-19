import {
  type FolderCreatedResponse,
  type FolderRenamedResponse,
  type FoldersResponse,
  folderNameSchema,
  type OkResponse,
  updateFolderSchema,
} from "@boreas/api-contracts";
import {
  feeds,
  folders,
  getDb,
  nowEpochMs,
  rankBetween,
  writeTombstones,
} from "@boreas/shared";
import { asc, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Env } from "../env";

/**
 * Routes Folder (montées sur /api/folders), sous le middleware de session.
 *
 * Un Folder regroupe des Feeds (jamais d'Articles), hiérarchie plate (#13,
 * CONTEXT.md). L'assignation Feed→Folder vit dans `feeds.folder_id` et se pilote
 * via `PATCH /feeds/:id` ; ce routeur ne gère que le cycle de vie des Folders.
 */
export const foldersRoutes = new Hono<{ Bindings: Env }>();

/** Liste des Folders, triés par rang fractionnaire (ordre manuel, ADR 0020). */
foldersRoutes.get("/", async (c) => {
  const db = getDb(c.env.DB);
  const rows = await db
    .select({ id: folders.id, name: folders.name, rank: folders.rank })
    .from(folders)
    // Tri par rang, `id` en départage : garantit un ordre **total déterministe**
    // même si deux Folders partageaient un rang (rééquilibrage en cours, conflit
    // multi-appareils ADR 0018, ou backfill historique non couvert).
    .orderBy(asc(folders.rank), asc(folders.id));

  return c.json({ folders: rows } satisfies FoldersResponse);
});

/**
 * Création d'un Folder. Le nom n'a pas à être unique. Le nouveau Folder est placé
 * **en fin de liste** : son rang s'intercale après le dernier rang existant
 * (`rankBetween(lastRank, null)`, ADR 0020). `updated_at` est posé à la création.
 */
foldersRoutes.post("/", async (c) => {
  const parsed = folderNameSchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return c.json({ error: "invalid_request" }, 400);
  }

  const id = crypto.randomUUID();
  const name = parsed.data.name;
  const db = getDb(c.env.DB);

  // Rang du dernier Folder (par rang desc) pour insérer après lui. `null` si la
  // liste est vide → première clé du conteneur.
  const [last] = await db
    .select({ rank: folders.rank })
    .from(folders)
    .orderBy(desc(folders.rank))
    .limit(1);
  const rank = rankBetween(last?.rank ?? null, null);

  await db.insert(folders).values({ id, name, rank });

  return c.json(
    { folder: { id, name, rank } } satisfies FolderCreatedResponse,
    201,
  );
});

/**
 * Renommage (#13) et/ou réordonnancement (#109) d'un Folder. Le corps porte
 * `name` et/ou `rank` (au moins un, sinon 400). Le `rank` est calculé côté client
 * (`rankBetween` des voisins, ADR 0020) et écrit **verbatim** : le serveur ne
 * recalcule rien et ne touche que la ligne ciblée (une seule ligne réécrite,
 * AC #109). `updated_at` est toujours bumpé (mutation de domaine, #69, ADR 0018).
 * 404 si l'id est inconnu. L'écho est le `folderSchema` complet relu.
 */
foldersRoutes.patch("/:id", async (c) => {
  const parsed = updateFolderSchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return c.json({ error: "invalid_request" }, 400);
  }
  const id = c.req.param("id");
  const db = getDb(c.env.DB);

  // Set partiel : on n'écrit que les champs présents ; `updated_at` toujours bumpé.
  const set: { name?: string; rank?: string; updated_at: number } = {
    updated_at: nowEpochMs(),
  };
  if (parsed.data.name !== undefined) set.name = parsed.data.name;
  if (parsed.data.rank !== undefined) set.rank = parsed.data.rank;

  // `returning` relit name+rank (le champ non modifié garde sa valeur en base)
  // pour ré-écho du `folderSchema` complet.
  const updated = await db
    .update(folders)
    .set(set)
    .where(eq(folders.id, id))
    .returning({ id: folders.id, name: folders.name, rank: folders.rank });

  const row = updated[0];
  if (!row) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.json({
    id: row.id,
    name: row.name,
    rank: row.rank,
  } satisfies FolderRenamedResponse);
});

/**
 * Suppression d'un Folder. La FK `feeds.folder_id` est en `ON DELETE no action`
 * (ADR 0011, comme `articles.feed_id`) : on **désassigne d'abord** ses Feeds
 * (`folder_id = null`, ils repassent « non classés ») avant de supprimer le
 * Folder, sinon le DELETE échouerait s'il reste des Feeds rattachés.
 */
foldersRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c.env.DB);

  // Désassignation des Feeds rattachés : c'est une mutation de domaine de chaque
  // Feed (son `folder_id` change) → bump `updated_at` (#69, ADR 0018). Les Feeds
  // ne reçoivent PAS de tombstone (ils subsistent, « non classés »).
  await db
    .update(feeds)
    .set({ folder_id: null, updated_at: nowEpochMs() })
    .where(eq(feeds.folder_id, id));

  // Delete destructif du Folder (ADR 0018) : on trace le tombstone **avant** le
  // hard-delete (comme le chokepoint articles) pour qu'un crash entre les deux ne
  // laisse pas un Folder supprimé sans tombstone — il subsisterait sur le réplica.
  // Idempotent et sans effet si le Folder n'existe pas, d'où le 404 dérivé du delete.
  await writeTombstones(db, "folder", [id]);
  const deleted = await db
    .delete(folders)
    .where(eq(folders.id, id))
    .returning({ id: folders.id });

  if (deleted.length === 0) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.json({ ok: true } satisfies OkResponse);
});
