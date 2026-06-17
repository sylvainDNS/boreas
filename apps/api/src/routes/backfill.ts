import type { BackfillResponse } from "@boreas/api-contracts";
import { enqueueFeedIds, feeds, getDb } from "@boreas/shared";
import { isNull } from "drizzle-orm";
import { Hono } from "hono";
import type { Env } from "../env";

/**
 * Route backfill global (montée sur /api/backfill), sous le middleware de session.
 *
 * Maintenance ponctuelle (#97) : re-fetche les flux et ré-sanitize **en place**
 * le contenu R2 des articles déjà stockés, pour récupérer les embeds que les
 * ingestions passées avaient perdus (ADR 0007 ne conserve que le HTML sanitizé).
 * Comme le refresh global (#10), on **enqueue** un message `mode:"backfill"` par
 * Feed actif et on répond aussitôt : le consommateur du Cron ré-sanitize en
 * arrière-plan (ADR 0002).
 */
export const backfillRoutes = new Hono<{ Bindings: Env }>();

backfillRoutes.post("/", async (c) => {
  const db = getDb(c.env.DB);
  // Mêmes flux que le refresh global : les désabonnés (#14) sont exclus (polling
  // arrêté, articles purgés — rien à ré-sanitizer).
  const rows = await db
    .select({ id: feeds.id })
    .from(feeds)
    .where(isNull(feeds.unsubscribed_at));
  await enqueueFeedIds(
    c.env.INGESTION_QUEUE,
    rows.map((r) => r.id),
    "backfill",
  );
  return c.json({ enqueued: rows.length } satisfies BackfillResponse);
});
