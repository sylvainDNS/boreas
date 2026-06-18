import { z } from "zod";

/** Nom de Folder : non vide après trim (création et renommage, #13). */
export const folderNameSchema = z.object({ name: z.string().trim().min(1) });
export type FolderNameInput = z.infer<typeof folderNameSchema>;

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
