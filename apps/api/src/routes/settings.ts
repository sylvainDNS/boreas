import { getDb, settings } from "@boreas/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";

/**
 * Réglages globaux (ligne unique `settings`, id=1) — #18. L'intervalle pilote la
 * cadence d'enqueue du Cron (#10, via `getRefreshIntervalMin`), la fenêtre de
 * purge le seuil de rétention (#15, via `getPurgeWindowDays`), le thème le SPA
 * (#4). Ces deux mécanismes lisent la ligne en temps réel : un PATCH ici suffit
 * à les reconfigurer, sans redéploiement.
 *
 * Monté sur /api/settings, sous la garde de session (absent de `isPublicPath`).
 */
export const settingsRoutes = new Hono<{ Bindings: Env }>();

/**
 * PATCH partiel : au moins un champ requis (`.refine`, comme `articles.ts`). Les
 * bornes sont larges côté serveur (1 min – 24 h, 1 j – 10 ans) ; les presets de
 * l'UI sont une contrainte d'ergonomie, pas d'API.
 */
const patchSchema = z
  .object({
    refreshIntervalMin: z.number().int().min(1).max(1440).optional(),
    purgeWindowDays: z.number().int().min(1).max(3650).optional(),
    theme: z.enum(["light", "dark", "system"]).optional(),
  })
  .refine(
    (d) =>
      d.refreshIntervalMin !== undefined ||
      d.purgeWindowDays !== undefined ||
      d.theme !== undefined,
    { message: "no_field" },
  );

/** Projection camelCase de la ligne (mêmes clés que `/api/health`). */
const SETTINGS_COLUMNS = {
  refreshIntervalMin: settings.refresh_interval_min,
  purgeWindowDays: settings.purge_window_days,
  theme: settings.theme,
} as const;

/** Lecture des réglages courants. */
settingsRoutes.get("/", async (c) => {
  const db = getDb(c.env.DB);
  const [row] = await db.select(SETTINGS_COLUMNS).from(settings).limit(1);

  if (!row) {
    return c.json({ error: "settings_not_found" }, 500);
  }
  return c.json(row);
});

/** Mise à jour partielle des réglages. */
settingsRoutes.patch("/", async (c) => {
  const parsed = patchSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "invalid_request" }, 400);
  }

  // Mapping API (camelCase) → colonnes DB (snake_case). Seuls les champs fournis
  // sont écrits (zod `.optional` n'injecte pas les absents).
  const set: {
    refresh_interval_min?: number;
    purge_window_days?: number;
    theme?: "light" | "dark" | "system";
  } = {};
  if (parsed.data.refreshIntervalMin !== undefined)
    set.refresh_interval_min = parsed.data.refreshIntervalMin;
  if (parsed.data.purgeWindowDays !== undefined)
    set.purge_window_days = parsed.data.purgeWindowDays;
  if (parsed.data.theme !== undefined) set.theme = parsed.data.theme;

  const db = getDb(c.env.DB);
  const updated = await db
    .update(settings)
    .set(set)
    .where(eq(settings.id, 1))
    .returning(SETTINGS_COLUMNS);

  if (updated.length === 0) {
    return c.json({ error: "settings_not_found" }, 500);
  }
  return c.json(updated[0]);
});
