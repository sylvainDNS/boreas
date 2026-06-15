import { getDb, settings } from "@boreas/shared";
import { Hono } from "hono";
import type { Env } from "./env";
import { hasValidSession } from "./lib/session";
import { articlesRoutes } from "./routes/articles";
import { authRoutes } from "./routes/auth";
import { feedsRoutes } from "./routes/feeds";
import { foldersRoutes } from "./routes/folders";
import { imgRoutes } from "./routes/img";
import { opmlRoutes } from "./routes/opml";
import { pushRoutes } from "./routes/push";
import { refreshRoutes } from "./routes/refresh";
import { settingsRoutes } from "./routes/settings";
import { syncRoutes } from "./routes/sync";

const app = new Hono<{ Bindings: Env }>();

/** Chemins `/api/*` accessibles sans session (auth + sonde de santé). */
function isPublicPath(path: string): boolean {
  return path === "/api/health" || path.startsWith("/api/auth/");
}

// --- Garde de session (fail-closed) ---
// Déclarée EN PREMIER pour couvrir tout /api/* quel que soit l'ordre d'ajout des
// routes : une vue métier (#6+) est protégée par défaut, sauf à figurer
// explicitement dans isPublicPath. On échoue donc fermé, pas ouvert.
app.use("/api/*", async (c, next) => {
  if (!isPublicPath(c.req.path) && !hasValidSession(c, c.env.HMAC_SECRET)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});

// --- Routes ---

app.route("/api/auth", authRoutes);
app.route("/api/feeds", feedsRoutes);
app.route("/api/folders", foldersRoutes);
app.route("/api/articles", articlesRoutes);
app.route("/api/refresh", refreshRoutes);
app.route("/api/opml", opmlRoutes);
app.route("/api/push", pushRoutes);
app.route("/api/img", imgRoutes);
app.route("/api/settings", settingsRoutes);
app.route("/api/sync", syncRoutes);

/**
 * GET /api/health
 *
 * Lit la ligne de settings en D1 et renvoie un statut.
 * Chemin témoin du walking skeleton : prouve que l'API atteint D1. Public
 * (cf. isPublicPath) : sonde de disponibilité.
 */
app.get("/api/health", async (c) => {
  try {
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
  } catch (err) {
    return c.json(
      {
        status: "error",
        detail: err instanceof Error ? err.message : "unknown",
      },
      500,
    );
  }
});

export default app;
