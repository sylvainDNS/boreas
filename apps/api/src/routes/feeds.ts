import { articleKey, articles, feeds, getDb, parseFeed } from "@boreas/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";

const subscribeSchema = z.object({ url: z.string().url() });

/** Lignes par insert : D1 plafonne à 100 variables liées (~10 colonnes/ligne). */
const INSERT_CHUNK = 9;

/**
 * Routes Feed (montées sur /api/feeds), sous le middleware de session.
 *
 * #6 n'expose que l'abonnement par URL de flux directe + ingestion synchrone.
 * Ce fetch synchrone sera refactoré vers le module `ingestion` partagé en #10.
 */
export const feedsRoutes = new Hono<{ Bindings: Env }>();

/**
 * Abonnement par URL de flux directe : refuse les doublons, fetch synchrone,
 * parse RSS/Atom, puis backfill des articles en non-lu (dédup par `articleKey`).
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

  // Fetch synchrone du flux.
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        "user-agent": "Boreas/1.0 (+https://boreas.sylvaindenyse.me)",
        accept:
          "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8",
      },
      redirect: "follow",
    });
  } catch (err) {
    console.error("[feeds] échec du fetch du flux", err);
    return c.json({ error: "fetch_failed" }, 502);
  }
  if (!response.ok) {
    return c.json({ error: "fetch_failed" }, 502);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const feed = parseFeed(bytes, response.headers.get("content-type"));
  if (feed.items.length === 0) {
    return c.json({ error: "invalid_feed" }, 422);
  }

  // Crée le Feed puis backfill ses articles en non-lu.
  const feedId = crypto.randomUUID();
  await db.insert(feeds).values({ id: feedId, url, title: feed.title });

  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const rows = feed.items.map((item) => ({
    id: crypto.randomUUID(),
    feed_id: feedId,
    article_key: articleKey(item, feedId),
    title: item.title,
    link: item.link,
    summary: item.summary,
    published_at: item.publishedAt,
    enclosures:
      item.enclosures.length > 0 ? JSON.stringify(item.enclosures) : null,
    read: false,
    fetched_at: now,
  }));

  // Insertion par lots : D1 borne une requête à 100 variables liées. Avec
  // ~10 colonnes par ligne, on insère au plus 9 articles par requête.
  // onConflictDoNothing sur (feed_id, article_key) : idempotent si le flux
  // contient des doublons internes. `returning` compte les insertions réelles.
  let articleCount = 0;
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const inserted = await db
      .insert(articles)
      .values(rows.slice(i, i + INSERT_CHUNK))
      .onConflictDoNothing()
      .returning({ id: articles.id });
    articleCount += inserted.length;
  }

  return c.json(
    { feed: { id: feedId, url, title: feed.title }, articleCount },
    201,
  );
});
