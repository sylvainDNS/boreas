import { z } from "zod";

/** `POST /api/opml/import` — corps JSON `{ opml }` (le SPA lit le fichier client). */
export const opmlImportSchema = z.object({ opml: z.string().min(1) });
export type OpmlImportInput = z.infer<typeof opmlImportSchema>;

/** Récapitulatif d'un import OPML (#17). */
export const opmlImportResponseSchema = z.object({
  imported: z.number(),
  reactivated: z.number(),
  skipped: z.number(),
  foldersCreated: z.number(),
});
export type OpmlImportResponse = z.infer<typeof opmlImportResponseSchema>;
