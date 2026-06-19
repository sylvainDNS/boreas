import { z } from "zod";

/** Nom de Folder à la **création** (POST) : non vide après trim (#13). */
export const folderNameSchema = z.object({ name: z.string().trim().min(1) });
export type FolderNameInput = z.infer<typeof folderNameSchema>;

/**
 * Corps du `PATCH /api/folders/:id` (#13 renommage, #109 réordonnancement) :
 * renommage (`name`) et/ou réordonnancement (`rank`). Les deux champs sont
 * **optionnels** mais le corps doit en porter **au moins un** (sinon 400 : un
 * PATCH vide n'a aucun effet de domaine). `rank` est une clé fractionnaire
 * calculée par le client (ADR 0020) et écrite **verbatim** par le serveur ; le
 * serveur ne recalcule rien.
 */
export const updateFolderSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    rank: z.string().min(1).optional(),
  })
  .refine((body) => body.name !== undefined || body.rank !== undefined, {
    message: "at least one field required",
  });
export type UpdateFolderInput = z.infer<typeof updateFolderSchema>;

/**
 * Folder côté wire : regroupement plat de Feeds (#13). `rank` (#108, ADR 0020)
 * est le rang fractionnaire d'ordre manuel ; le réplica local et la sidebar
 * trient dessus. Schéma unique partagé par toutes les réponses Folder (liste,
 * création, renommage) et par le delta sync.
 */
export const folderSchema = z.object({
  id: z.string(),
  name: z.string(),
  rank: z.string(),
});
export type Folder = z.infer<typeof folderSchema>;

/** `GET /api/folders` — liste triée par rang (ADR 0020). */
export const foldersResponseSchema = z.object({
  folders: z.array(folderSchema),
});
export type FoldersResponse = z.infer<typeof foldersResponseSchema>;

/** `POST /api/folders` (201). */
export const folderCreatedResponseSchema = z.object({ folder: folderSchema });
export type FolderCreatedResponse = z.infer<typeof folderCreatedResponseSchema>;

/** `PATCH /api/folders/:id` — écho du renommage. */
export const folderRenamedResponseSchema = folderSchema;
export type FolderRenamedResponse = z.infer<typeof folderRenamedResponseSchema>;
