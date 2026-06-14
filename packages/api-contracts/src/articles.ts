import { z } from "zod";

/** Filtre de la liste (#8/#9) : non-lus seuls, lus + non-lus, ou Saved seuls. */
export const articleFilterSchema = z.enum(["unread", "all", "saved"]);
export type ArticleFilter = z.infer<typeof articleFilterSchema>;

/** Bascule manuelle Read/Saved (`PATCH /api/articles/:id`) : au moins un champ. */
export const articlePatchSchema = z
  .object({ read: z.boolean().optional(), saved: z.boolean().optional() })
  .refine((d) => d.read !== undefined || d.saved !== undefined, {
    message: "no_field",
  });
export type ArticlePatch = z.infer<typeof articlePatchSchema>;

/** « Tout marquer lu » (#8/#13) : global, un Feed ou un Folder. */
export const markReadRequestSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("global") }),
  z.object({ scope: z.literal("feed"), feedId: z.string().min(1) }),
  z.object({ scope: z.literal("folder"), folderId: z.string().min(1) }),
]);
export type MarkReadRequest = z.infer<typeof markReadRequestSchema>;

/** Item de la liste paginée (`GET /api/articles`). Remplace l'ancien `ArticleDto`. */
export const articleListItemSchema = z.object({
  id: z.string(),
  feedId: z.string(),
  feedName: z.string(),
  title: z.string().nullable(),
  summary: z.string().nullable(),
  link: z.string().nullable(),
  publishedAt: z.string().nullable(),
  /** Date d'ingestion (NOT NULL) : fallback d'affichage quand publishedAt est null (ADR 0015). */
  fetchedAt: z.string(),
  read: z.boolean(),
  saved: z.boolean(),
});
export type ArticleListItem = z.infer<typeof articleListItemSchema>;

/** `GET /api/articles` — page keyset. */
export const articleListResponseSchema = z.object({
  articles: z.array(articleListItemSchema),
  nextCursor: z.string().nullable(),
});
export type ArticleListResponse = z.infer<typeof articleListResponseSchema>;

/** `GET /api/articles/:id` — contenu plein du lecteur (#7). */
export const articleDetailResponseSchema = z.object({
  id: z.string(),
  /** Feed source (jointure stable) : permet au lecteur de lier le titre du Feed
   *  vers sa liste d'articles même en deep-link/refresh (item hors liste en cache). */
  feedId: z.string(),
  feedName: z.string(),
  title: z.string().nullable(),
  link: z.string().nullable(),
  publishedAt: z.string().nullable(),
  content: z.string().nullable(),
  /** État Saved et non-lu : permet au lecteur de se rendre depuis le seul `id`
   *  (deep-link/refresh sur un Article hors de la page de liste chargée).
   *  `unread` reflète l'état AVANT le marquage Read induit par ce GET. */
  saved: z.boolean(),
  unread: z.boolean(),
});
export type ArticleDetailResponse = z.infer<typeof articleDetailResponseSchema>;

/** `GET /api/articles/counts` — compteurs de non-lus exacts (#8/#13). */
export const articleCountsResponseSchema = z.object({
  total: z.number(),
  byFeed: z.array(z.object({ feedId: z.string(), count: z.number() })),
  byFolder: z.array(z.object({ folderId: z.string(), count: z.number() })),
});
export type ArticleCountsResponse = z.infer<typeof articleCountsResponseSchema>;

/** `PATCH /api/articles/:id` — écho des seuls champs modifiés (+ id). */
export const articlePatchResponseSchema = z.object({
  id: z.string(),
  read: z.boolean().optional(),
  saved: z.boolean().optional(),
});
export type ArticlePatchResponse = z.infer<typeof articlePatchResponseSchema>;

/** `POST /api/articles/mark-read` — nombre d'articles basculés. */
export const markReadResponseSchema = z.object({ updated: z.number() });
export type MarkReadResponse = z.infer<typeof markReadResponseSchema>;
