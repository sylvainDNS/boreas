import { z } from "zod";

/** `POST /api/backfill` — nombre de Feeds enqueués pour ré-sanitization (#97). */
export const backfillResponseSchema = z.object({ enqueued: z.number() });
export type BackfillResponse = z.infer<typeof backfillResponseSchema>;
