import { z } from "zod";

/** Nom de Folder : non vide après trim (création et renommage, #13). */
export const folderNameSchema = z.object({ name: z.string().trim().min(1) });
export type FolderNameInput = z.infer<typeof folderNameSchema>;

/** Folder côté wire : regroupement plat de Feeds (#13). */
export const folderSchema = z.object({ id: z.string(), name: z.string() });
export type Folder = z.infer<typeof folderSchema>;

/** `GET /api/folders` — liste triée par nom. */
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
