import { extractArticle } from "@boreas/content-extractor";
import { sanitizeHtml } from "@boreas/html-sanitizer";
import {
  articleKey,
  articles,
  feeds,
  getDb,
  parseFeed,
  sqlUtcNow,
} from "@boreas/shared";
import { signImageUrl } from "@boreas/shared/crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";

const subscribeSchema = z.object({ url: z.string().url() });

// D1 plafonne une requête à 100 variables liées. On dérive la taille de lot du
// nombre de colonnes posées par ligne (avec marge) pour qu'elle s'ajuste
// automatiquement si une colonne est ajoutée à `articles` (#7+), au lieu d'un
// nombre magique qui dépasserait la limite silencieusement.
const ARTICLE_INSERT_COLUMNS = 12;
const D1_MAX_BOUND_PARAMS = 100;
const INSERT_CHUNK = Math.floor(
  (D1_MAX_BOUND_PARAMS - 1) / ARTICLE_INSERT_COLUMNS,
);

// Concurrence max de l'extraction+sanitization+put R2 par lot. Chaque item
// déclenche un parse linkedom (CPU) + un put R2 (sous-requête) ; un flux peut
// contenir des centaines d'items, donc on borne pour ne pas saturer le budget
// CPU/sous-requêtes du Worker sur le chemin synchrone d'abonnement.
const EXTRACT_CONCURRENCY = 6;

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

  // Extraction + sanitization + stockage R2 du contenu plein (ADR 0003/0007),
  // par lots à concurrence bornée (cf. EXTRACT_CONCURRENCY). Un échec sur un
  // article le laisse sans contenu (content_key null) sans bloquer l'abonnement.
  const now = sqlUtcNow();
  const secret = c.env.HMAC_SECRET;
  const buildRow = async (item: (typeof feed.items)[number]) => {
    const id = crypto.randomUUID();
    const contentKey = await extractAndStore(
      c.env.BUCKET,
      secret,
      id,
      item.content,
      item.link ?? url,
    );
    return {
      id,
      feed_id: feedId,
      article_key: articleKey(item, feedId),
      title: item.title,
      link: item.link,
      summary: item.summary,
      published_at: item.publishedAt,
      enclosures:
        item.enclosures.length > 0 ? JSON.stringify(item.enclosures) : null,
      content_key: contentKey,
      read: false,
      fetched_at: now,
    };
  };

  const rows: Awaited<ReturnType<typeof buildRow>>[] = [];
  for (let i = 0; i < feed.items.length; i += EXTRACT_CONCURRENCY) {
    const batch = feed.items.slice(i, i + EXTRACT_CONCURRENCY);
    rows.push(...(await Promise.all(batch.map(buildRow))));
  }

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

/**
 * Extrait + sanitize le contenu HTML d'un item et le stocke en R2 sous
 * `articles/{id}.html`. Renvoie la clé R2, ou `null` si le flux ne fournit pas
 * de contenu ou en cas d'échec — l'abonnement n'est jamais interrompu pour un
 * seul article (try/catch, log).
 */
async function extractAndStore(
  bucket: R2Bucket,
  secret: string,
  id: string,
  rawContent: string | null,
  baseUrl: string | null,
): Promise<string | null> {
  if (!rawContent) return null;
  try {
    const extracted = extractArticle(rawContent, baseUrl ?? "");
    const safe = sanitizeHtml(extracted.content, {
      baseUrl: baseUrl ?? undefined,
      signImageSrc: (src) => signImageUrl(secret, src),
    });
    const key = `articles/${id}.html`;
    await bucket.put(key, safe, {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
    });
    return key;
  } catch (err) {
    console.error("[feeds] extraction/stockage du contenu échoué", err);
    return null;
  }
}
