import {
  type FolderCreatedResponse,
  type FolderRenamedResponse,
  type FoldersResponse,
  folderNameSchema,
  type OkResponse,
} from "@boreas/api-contracts";
import { feeds, folders, getDb } from "@boreas/shared";
import { asc, eq } from "drizzle-orm";
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

/** Liste des Folders, triés par nom (ordre stable pour la sidebar). */
foldersRoutes.get("/", async (c) => {
  const db = getDb(c.env.DB);
  const rows = await db
    .select({ id: folders.id, name: folders.name })
    .from(folders)
    .orderBy(asc(folders.name));

  return c.json({ folders: rows } satisfies FoldersResponse);
});

/** Création d'un Folder. Le nom n'a pas à être unique. */
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
  await db.insert(folders).values({ id, name });

  return c.json({ folder: { id, name } } satisfies FolderCreatedResponse, 201);
});

/** Renommage d'un Folder. 404 si l'id est inconnu. */
foldersRoutes.patch("/:id", async (c) => {
  const parsed = folderNameSchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return c.json({ error: "invalid_request" }, 400);
  }
  const id = c.req.param("id");
  const db = getDb(c.env.DB);

  const updated = await db
    .update(folders)
    .set({ name: parsed.data.name })
    .where(eq(folders.id, id))
    .returning({ id: folders.id });

  if (updated.length === 0) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.json({ id, name: parsed.data.name } satisfies FolderRenamedResponse);
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

  await db
    .update(feeds)
    .set({ folder_id: null })
    .where(eq(feeds.folder_id, id));

  const deleted = await db
    .delete(folders)
    .where(eq(folders.id, id))
    .returning({ id: folders.id });

  if (deleted.length === 0) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.json({ ok: true } satisfies OkResponse);
});
