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

/**
 * `GET /api/articles/:id` — contenu plein du lecteur (#7).
 *
 * **#75 (ADR 0018)** : ce GET **ne marque plus Read** (l'effet de bord est retiré ;
 * le Read devient une mutation client à l'ouverture, via l'outbox). Le détail du
 * lecteur est désormais lu **local-first** (réplica + store content) ; cet endpoint
 * reste fonctionnel comme fallback / usage tiers, sans effet de bord. `unread`
 * reflète donc l'état Read **courant** (plus « avant marquage », ce dernier
 * n'existant plus).
 */
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
   *  `unread` reflète l'état Read courant (le GET ne marque plus Read, #75). */
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

/**
 * `POST /api/articles/content` — batch de contenu HTML (#75, ADR 0018).
 *
 * Récupère le HTML extrait/sanitizé (R2) de plusieurs articles **en une requête**,
 * **sans effet de bord Read** : le moteur de sync l'appelle pour pré-télécharger
 * le corpus offline (non-lus ∪ Saved) sans passer ces articles en lus — c'est ce
 * qui distingue ce batch du `GET /api/articles/:id` (dont l'effet Read est retiré
 * en #75, le Read devenant une mutation client à l'ouverture).
 */
export const articleContentRequestSchema = z.object({
  // Borné à la limite de variables liées de D1 (100) : le serveur exécute le batch
  // via un `IN (…)` d'un paramètre par id, et ouvre un `BUCKET.get` R2 par id. Sans
  // cette borne, un lot trop grand ferait échouer la requête D1 et laisserait le
  // fan-out R2 non plafonné. Le client (moteur de sync) chunke déjà plus bas (50) ;
  // ce max protège l'endpoint quel que soit l'appelant.
  ids: z.array(z.string()).max(100),
});
export type ArticleContentRequest = z.infer<typeof articleContentRequestSchema>;

/**
 * Item de réponse du batch content : le HTML d'un article, ou `null` quand
 * l'extraction n'a rien produit / l'objet R2 est absent (dégradation, pas
 * d'erreur). Les ids inconnus ne figurent pas dans la réponse.
 */
export const articleContentItemSchema = z.object({
  id: z.string(),
  html: z.string().nullable(),
});
export type ArticleContentItem = z.infer<typeof articleContentItemSchema>;

/** `POST /api/articles/content` — HTML des ids demandés (sans effet Read). */
export const articleContentResponseSchema = z.array(articleContentItemSchema);
export type ArticleContentResponse = z.infer<
  typeof articleContentResponseSchema
>;
