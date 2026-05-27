import { Hono } from "hono";
import { getDb, settings } from "@boreas/shared";

interface Env {
  DB: D1Database;
  /** Queue d'ingestion — producer binding (utilisé au #10). */
  INGESTION_QUEUE: Queue;
}

const app = new Hono<{ Bindings: Env }>();

/**
 * GET /api/health
 *
 * Lit la ligne de settings en D1 et renvoie un statut.
 * Chemin témoin du walking skeleton : prouve que l'API atteint D1.
 */
app.get("/api/health", async (c) => {
  const db = getDb(c.env.DB);
  const [row] = await db.select().from(settings).limit(1);

  if (!row) {
    return c.json({ status: "error", detail: "settings row missing" }, 500);
  }

  return c.json({
    status: "ok",
    refreshIntervalMin: row.refresh_interval_min,
    purgeWindowDays: row.purge_window_days,
    theme: row.theme,
  });
});

export default app;
