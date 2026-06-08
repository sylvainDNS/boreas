import {
  articles,
  ERROR_THRESHOLD,
  feeds,
  getDb,
  ingestFeed,
} from "@boreas/shared";
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";

const subscribeSchema = z.object({ url: z.string().url() });

/**
 * Routes Feed (montées sur /api/feeds), sous le middleware de session.
 *
 * L'abonnement (#6) et le refresh manuel passent par le même module `ingestion`
 * partagé (`ingestFeed`, ADR 0002) que le consommateur de Queue du Cron (#10).
 */
export const feedsRoutes = new Hono<{ Bindings: Env }>();

/**
 * Liste des Feeds avec leur santé (#11) : la sidebar du SPA y lit le badge
 * « en erreur ». `status` est **dérivé** de `consecutive_failures`
 * (≥ `ERROR_THRESHOLD` = en erreur) plutôt que stocké, pour éviter une donnée
 * redondante. Trié par titre (puis URL) pour un ordre stable.
 */
feedsRoutes.get("/", async (c) => {
  const db = getDb(c.env.DB);
  const rows = await db
    .select({
      id: feeds.id,
      url: feeds.url,
      title: feeds.title,
      consecutiveFailures: feeds.consecutive_failures,
      lastError: feeds.last_error,
      lastCheckAt: feeds.last_check_at,
    })
    .from(feeds)
    .orderBy(asc(feeds.title), asc(feeds.url));

  return c.json({
    feeds: rows.map((row) => ({
      id: row.id,
      url: row.url,
      title: row.title,
      status: row.consecutiveFailures >= ERROR_THRESHOLD ? "error" : "ok",
      lastError: row.lastError,
      lastCheckAt: row.lastCheckAt,
    })),
  });
});

/**
 * Abonnement par URL de flux directe : refuse les doublons, crée le Feed, puis
 * délègue le backfill à `ingestFeed` (fetch → parse → extraction → upsert).
 */
feedsRoutes.post("/", async (c) => {
  const parsed = subscribeSchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return c.json({ error: "invalid_request" }, 400);
  }
  const url = parsed.data.url.trim();

  const db = getDb(c.env.DB);

  // Dédup d'abonnement : un Feed déjà suivi est refusé.
  const [existing] = await db
    .select({ id: feeds.id })
    .from(feeds)
    .where(eq(feeds.url, url))
    .limit(1);
  if (existing) {
    return c.json({ error: "already_subscribed" }, 409);
  }

  // Crée le Feed puis backfill ses articles via le module d'ingestion partagé.
  const feedId = crypto.randomUUID();
  await db.insert(feeds).values({ id: feedId, url });

  // ingestFeed ne lève pas sur un fetch KO (il renvoie status:"error"), mais une
  // panne D1/R2 en cours d'insertion peut remonter : on la traite comme un échec
  // d'abonnement plutôt que de laisser une 500 + un Feed orphelin.
  let result: Awaited<ReturnType<typeof ingestFeed>> | null = null;
  try {
    result = await ingestFeed(feedId, db, c.env.BUCKET, c.env.HMAC_SECRET);
  } catch (err) {
    console.error("[feeds] ingestion levée à l'abonnement", feedId, err);
  }

  if (!result || result.status === "error" || result.itemCount === 0) {
    // Rollback de l'abonnement. On supprime d'abord les articles éventuellement
    // insérés avant l'erreur : la FK `articles.feed_id` est en ON DELETE no
    // action, donc supprimer le Feed seul échouerait s'il en reste.
    await db.delete(articles).where(eq(articles.feed_id, feedId));
    await db.delete(feeds).where(eq(feeds.id, feedId));
    // Flux joignable et parsé mais sans item = illisible (422) ; tout échec de
    // fetch/parse (status "error", ou exception) = fetch KO (502).
    return result && result.status !== "error" && result.itemCount === 0
      ? c.json({ error: "invalid_feed" }, 422)
      : c.json({ error: "fetch_failed" }, 502);
  }

  return c.json(
    {
      feed: { id: feedId, url, title: result.title },
      articleCount: result.inserted,
    },
    201,
  );
});

/**
 * Refresh manuel d'un Feed (fetch serveur immédiat) : rejoue l'ingestion et
 * renvoie le nombre de nouveaux articles. 404 si le Feed est inconnu.
 */
feedsRoutes.post("/:id/refresh", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c.env.DB);

  const [feed] = await db
    .select({ id: feeds.id })
    .from(feeds)
    .where(eq(feeds.id, id))
    .limit(1);
  if (!feed) {
    return c.json({ error: "not_found" }, 404);
  }

  const result = await ingestFeed(id, db, c.env.BUCKET, c.env.HMAC_SECRET);
  return c.json({ inserted: result.inserted, status: result.status });
});
