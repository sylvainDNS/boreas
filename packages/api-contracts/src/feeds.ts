import { z } from "zod";

/** Abonnement par URL (de flux ou de site, #12). Aussi utilisé par `/discover`. */
export const subscribeSchema = z.object({ url: z.string().url() });
export type SubscribeInput = z.infer<typeof subscribeSchema>;

/**
 * Renommage et/ou déplacement d'un Feed (#13). `title` non vide pour renommer ;
 * `folderId` (uuid) pour assigner, `null` pour désassigner ; au moins un champ.
 */
export const updateFeedSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    folderId: z.string().min(1).nullable().optional(),
  })
  .refine((d) => d.title !== undefined || d.folderId !== undefined, {
    message: "no_field",
  });
export type UpdateFeedInput = z.infer<typeof updateFeedSchema>;

/** Flux candidat de l'auto-découverte (#12). Miroir wire de `DiscoveredFeed`. */
export const discoveredFeedSchema = z.object({
  url: z.string(),
  title: z.string().nullable(),
  type: z.enum(["rss", "atom"]),
});
export type DiscoveredFeed = z.infer<typeof discoveredFeedSchema>;

/** Santé d'un Feed (#11) : `status` dérivé de `consecutive_failures`. */
export const feedSchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string().nullable(),
  status: z.enum(["ok", "error"]),
  lastError: z.string().nullable(),
  lastCheckAt: z.string().nullable(),
  folderId: z.string().nullable(),
  /**
   * Rang fractionnaire (#110, ADR 0020), scopé au conteneur (le Folder
   * `folderId`, ou la zone « sans dossier » si `folderId` est `null`). Sert à
   * l'ordre manuel des Feeds au sein de leur conteneur. Se propage au wire de
   * sync via `syncFeedSchema.extend`.
   */
  rank: z.string(),
});
export type Feed = z.infer<typeof feedSchema>;

/** `GET /api/feeds`. */
export const feedsResponseSchema = z.object({ feeds: z.array(feedSchema) });
export type FeedsResponse = z.infer<typeof feedsResponseSchema>;

/** Codes d'échec d'abonnement (mappés vers un statut HTTP côté route). */
export const subscribeErrorCodeSchema = z.enum([
  "already_subscribed",
  "invalid_feed",
  "fetch_failed",
]);
export type SubscribeErrorCode = z.infer<typeof subscribeErrorCodeSchema>;

/** Feed minimal renvoyé à l'abonnement réussi. */
export const subscribedFeedSchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string().nullable(),
});

/** `POST /api/feeds` (201) — abonnement réussi (flux direct ou site mono-flux). */
export const subscribeSubscribedResponseSchema = z.object({
  feed: subscribedFeedSchema,
  articleCount: z.number(),
});
export type SubscribeSubscribedResponse = z.infer<
  typeof subscribeSubscribedResponseSchema
>;

/** `POST /api/feeds` (200) — site multi-flux : liste à choisir (aucun Feed créé). */
export const subscribeCandidatesResponseSchema = z.object({
  candidates: z.array(discoveredFeedSchema),
});
export type SubscribeCandidatesResponse = z.infer<
  typeof subscribeCandidatesResponseSchema
>;

/**
 * `POST /api/feeds/discover` — auto-découverte sans abonnement (#12). Même forme
 * que la réponse multi-flux de `POST /api/feeds` : on réutilise son schéma plutôt
 * que d'en maintenir une copie identique.
 */
export const discoverResponseSchema = subscribeCandidatesResponseSchema;
export type DiscoverResponse = SubscribeCandidatesResponse;

/** `POST /api/feeds/:id/refresh` — issue d'un refresh manuel. */
export const feedRefreshResponseSchema = z.object({
  inserted: z.number(),
  status: z.enum(["updated", "not_modified", "error"]),
});
export type FeedRefreshResponse = z.infer<typeof feedRefreshResponseSchema>;

/** `PATCH /api/feeds/:id` — écho des seuls champs modifiés (+ id). */
export const feedUpdatedResponseSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  folderId: z.string().nullable().optional(),
});
export type FeedUpdatedResponse = z.infer<typeof feedUpdatedResponseSchema>;

/** `POST /api/feeds/:id/unsubscribe` (#14). */
export const feedUnsubscribedResponseSchema = z.object({
  id: z.string(),
  unsubscribed: z.literal(true),
});
export type FeedUnsubscribedResponse = z.infer<
  typeof feedUnsubscribedResponseSchema
>;
