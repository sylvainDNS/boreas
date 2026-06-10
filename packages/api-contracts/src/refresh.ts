import { z } from "zod";

/** `POST /api/refresh` — nombre de Feeds enqueués pour ingestion (#10). */
export const refreshResponseSchema = z.object({ enqueued: z.number() });
export type RefreshResponse = z.infer<typeof refreshResponseSchema>;
