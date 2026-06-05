import { enqueueFeedIds, feeds, getDb } from "@boreas/shared";
import { Hono } from "hono";
import type { Env } from "../env";

/**
 * Route refresh global (montée sur /api/refresh), sous le middleware de session.
 *
 * Contrairement au refresh d'un Feed (`POST /api/feeds/:id/refresh`, synchrone),
 * le refresh global **enqueue** un message par Feed dans la Queue d'ingestion et
 * répond aussitôt : le consommateur du Cron ingère en arrière-plan (ADR 0002).
 */
export const refreshRoutes = new Hono<{ Bindings: Env }>();

refreshRoutes.post("/", async (c) => {
  const db = getDb(c.env.DB);
  const rows = await db.select({ id: feeds.id }).from(feeds);
  await enqueueFeedIds(
    c.env.INGESTION_QUEUE,
    rows.map((r) => r.id),
  );
  return c.json({ enqueued: rows.length });
});
