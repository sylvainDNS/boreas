import { extractArticle } from "@boreas/content-extractor";
import { sanitizeHtml } from "@boreas/html-sanitizer";
import { eq, isNull, lte, or } from "drizzle-orm";
import { articleKey } from "./article-identity";
import { signImageUrl } from "./crypto";
import type { Db } from "./db";
import { articles, feeds, settings } from "./db";
import type { ParsedItem } from "./feed-parser";
import { parseFeed } from "./feed-parser";
import { sqlUtcNow } from "./timestamp";

// D1 plafonne une requête à 100 variables liées. On dérive la taille de lot du
// nombre de colonnes posées par ligne (avec marge) pour qu'elle s'ajuste
// automatiquement si une colonne est ajoutée à `articles`, au lieu d'un nombre
// magique qui dépasserait la limite silencieusement.
const ARTICLE_INSERT_COLUMNS = 12;
const D1_MAX_BOUND_PARAMS = 100;
const INSERT_CHUNK = Math.floor(
  (D1_MAX_BOUND_PARAMS - 1) / ARTICLE_INSERT_COLUMNS,
);

// Concurrence max de l'extraction+sanitization+put R2 par lot. Chaque item
// déclenche un parse linkedom (CPU) + un put R2 (sous-requête) ; un flux peut
// contenir des centaines d'items, donc on borne pour ne pas saturer le budget
// CPU/sous-requêtes du Worker.
const EXTRACT_CONCURRENCY = 6;

// Repli quand `settings.refresh_interval_min` est introuvable (base non seedée).
const DEFAULT_REFRESH_INTERVAL_MIN = 30;

const FETCH_HEADERS = {
  "user-agent": "Boreas/1.0 (+https://boreas.sylvaindenyse.me)",
  accept:
    "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8",
} as const;

/** Corps d'un message de la Queue d'ingestion : le Feed à ingérer (#10, ADR 0002). */
export interface IngestionMessage {
  feedId: string;
}

/** Issue d'une ingestion d'un Feed (un message de queue / un refresh manuel). */
export interface IngestResult {
  feedId: string;
  /** `updated` = fetch 2xx traité ; `not_modified` = 304 ; `error` = feed absent / fetch KO. */
  status: "updated" | "not_modified" | "error";
  /** Nouveaux articles réellement insérés (0 si rien de neuf ou 304). */
  inserted: number;
  /** Items présents dans le flux parsé (0 sur 304/erreur) ; sert à détecter un flux illisible. */
  itemCount: number;
  /** Titre du flux après ingestion (évite un re-SELECT à l'appelant). */
  title: string | null;
  error?: string;
}

// `sendBatch` est plafonné à 100 messages par requête (API Queues).
const QUEUE_BATCH_MAX = 100;

/**
 * Enqueue un message d'ingestion par Feed, en respectant la limite de 100
 * messages par `sendBatch` (API Queues). Partagé par le refresh global (#10)
 * et le Cron `scheduled` (ADR 0002).
 */
export async function enqueueFeedIds(
  queue: Queue<IngestionMessage>,
  feedIds: string[],
): Promise<void> {
  for (let i = 0; i < feedIds.length; i += QUEUE_BATCH_MAX) {
    const chunk = feedIds.slice(i, i + QUEUE_BATCH_MAX);
    await queue.sendBatch(chunk.map((feedId) => ({ body: { feedId } })));
  }
}

/**
 * Calcule l'échéance de prochaine vérif d'un Feed : `now + intervalle + jitter`.
 *
 * Le jitter (fraction aléatoire de l'intervalle) étale les échéances des feeds
 * pour qu'ils ne soient pas tous dus au même tick de Cron (ADR 0002 « échéances
 * étalées »). Exporté pour test.
 */
export function computeNextCheckAt(
  intervalMinutes: number,
  now: Date = new Date(),
): string {
  const intervalMs = intervalMinutes * 60_000;
  const jitterMs = Math.floor(Math.random() * intervalMs * 0.25);
  return sqlUtcNow(new Date(now.getTime() + intervalMs + jitterMs));
}

/**
 * Construit les en-têtes de requête, en ajoutant les en-têtes de *conditional
 * GET* seulement s'ils sont connus (ETag → If-None-Match, Last-Modified →
 * If-Modified-Since). Exporté pour test.
 */
export function buildConditionalHeaders(
  etag: string | null,
  lastModified: string | null,
): Record<string, string> {
  const headers: Record<string, string> = { ...FETCH_HEADERS };
  if (etag) headers["if-none-match"] = etag;
  if (lastModified) headers["if-modified-since"] = lastModified;
  return headers;
}

/**
 * Ingestion d'un Feed, partagée par l'abonnement (#6), le refresh manuel et le
 * consommateur de Queue (Cron, ADR 0002) :
 *   conditional GET → parse → filtrage des nouvelles clés → extraction +
 *   sanitization + stockage R2 → upsert (`onConflictDoNothing`) → MAJ du Feed.
 *
 * L'upsert **n'écrase jamais l'état Read** d'un Article existant : les lignes en
 * conflit sur `(feed_id, article_key)` sont laissées intactes. `last_check_at` et
 * `next_check_at` sont toujours avancés, même sur 304 ou erreur de fetch, pour ne
 * pas re-déclencher le feed à chaque tick (backoff fin = #11).
 */
export async function ingestFeed(
  feedId: string,
  db: Db,
  bucket: R2Bucket,
  secret: string,
): Promise<IngestResult> {
  const [feed] = await db
    .select({
      url: feeds.url,
      title: feeds.title,
      etag: feeds.etag,
      lastModified: feeds.last_modified,
    })
    .from(feeds)
    .where(eq(feeds.id, feedId))
    .limit(1);
  if (!feed) {
    return {
      feedId,
      status: "error",
      inserted: 0,
      itemCount: 0,
      title: null,
      error: "feed_not_found",
    };
  }

  const intervalMin = await getRefreshIntervalMin(db);

  // Issue de l'ingestion + métadonnées de polling à persister sur le Feed.
  let status: IngestResult["status"] = "updated";
  let error: string | undefined;
  let inserted = 0;
  let itemCount = 0;
  let nextEtag = feed.etag;
  let nextLastModified = feed.lastModified;
  let nextTitle = feed.title;

  try {
    const response = await fetch(feed.url, {
      headers: buildConditionalHeaders(feed.etag, feed.lastModified),
      redirect: "follow",
    });

    if (response.status === 304) {
      status = "not_modified";
    } else if (!response.ok) {
      status = "error";
      error = `http_${response.status}`;
    } else {
      nextEtag = response.headers.get("etag");
      nextLastModified = response.headers.get("last-modified");
      const bytes = new Uint8Array(await response.arrayBuffer());
      const parsed = parseFeed(bytes, response.headers.get("content-type"));
      itemCount = parsed.items.length;
      // Le titre du flux peut évoluer ; on le garde à jour (ne l'écrase pas par null).
      if (parsed.title) nextTitle = parsed.title;
      inserted = await upsertNewArticles(
        db,
        bucket,
        secret,
        feedId,
        feed.url,
        parsed.items,
      );
    }
  } catch (err) {
    status = "error";
    error = err instanceof Error ? err.message : "fetch_failed";
    console.error("[ingestion] échec du fetch du flux", feedId, err);
  }

  // Toujours avancer les échéances (même 304/erreur), et persister titre +
  // validateurs de cache quand un 200 nous en a donné.
  await db
    .update(feeds)
    .set({
      title: nextTitle,
      etag: nextEtag,
      last_modified: nextLastModified,
      last_check_at: sqlUtcNow(),
      next_check_at: computeNextCheckAt(intervalMin),
    })
    .where(eq(feeds.id, feedId));

  return { feedId, status, inserted, itemCount, title: nextTitle, error };
}

/**
 * Identifiants des Feeds dus à l'instant `now` : `next_check_at` échu ou jamais
 * vérifié (null = dû immédiatement). Sélection du Cron avant l'enqueue (ADR 0002).
 */
export async function getDueFeedIds(
  db: Db,
  now: Date = new Date(),
): Promise<string[]> {
  const nowSql = sqlUtcNow(now);
  const rows = await db
    .select({ id: feeds.id })
    .from(feeds)
    .where(or(isNull(feeds.next_check_at), lte(feeds.next_check_at, nowSql)));
  return rows.map((r) => r.id);
}

/** Intervalle de rafraîchissement du singleton `settings`, avec repli. */
async function getRefreshIntervalMin(db: Db): Promise<number> {
  const [row] = await db
    .select({ interval: settings.refresh_interval_min })
    .from(settings)
    .limit(1);
  return row?.interval ?? DEFAULT_REFRESH_INTERVAL_MIN;
}

/**
 * Extrait, sanitize, stocke en R2 et insère les Articles dont la clé de dédup
 * n'existe pas déjà pour ce Feed. Renvoie le nombre d'insertions réelles.
 *
 * Le filtrage par clé existante évite de ré-extraire (CPU) et ré-écrire R2 tous
 * les items à chaque poll ; sur un abonnement neuf, toutes les clés sont
 * absentes → backfill complet (comportement #6 inchangé).
 */
async function upsertNewArticles(
  db: Db,
  bucket: R2Bucket,
  secret: string,
  feedId: string,
  feedUrl: string,
  items: ParsedItem[],
): Promise<number> {
  if (items.length === 0) return 0;

  // Clés déjà présentes pour ce Feed (borné par le nombre d'articles du flux).
  // Le Set sert aussi de garde de dédup interne au flux : on y ajoute les clés
  // au fur et à mesure, en gardant l'ordre des items.
  const existingRows = await db
    .select({ key: articles.article_key })
    .from(articles)
    .where(eq(articles.feed_id, feedId));
  const seen = new Set(existingRows.map((r) => r.key));

  const fresh: { item: ParsedItem; key: string }[] = [];
  for (const item of items) {
    const key = articleKey(item, feedId);
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push({ item, key });
  }
  if (fresh.length === 0) return 0;

  const now = sqlUtcNow();
  const buildRow = async ({ item, key }: { item: ParsedItem; key: string }) => {
    const id = crypto.randomUUID();
    const contentKey = await extractAndStore(
      bucket,
      secret,
      id,
      item.content,
      item.link ?? feedUrl,
    );
    return {
      id,
      feed_id: feedId,
      article_key: key,
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
  for (let i = 0; i < fresh.length; i += EXTRACT_CONCURRENCY) {
    const batch = fresh.slice(i, i + EXTRACT_CONCURRENCY);
    rows.push(...(await Promise.all(batch.map(buildRow))));
  }

  // onConflictDoNothing sur (feed_id, article_key) : idempotent et sans reset du
  // Read d'un Article existant. `returning` compte les insertions réelles.
  let count = 0;
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const result = await db
      .insert(articles)
      .values(rows.slice(i, i + INSERT_CHUNK))
      .onConflictDoNothing()
      .returning({ id: articles.id });
    count += result.length;
  }
  return count;
}

/**
 * Extrait + sanitize le contenu HTML d'un item et le stocke en R2 sous
 * `articles/{id}.html`. Renvoie la clé R2, ou `null` si le flux ne fournit pas
 * de contenu ou en cas d'échec — l'ingestion n'est jamais interrompue pour un
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
    console.error("[ingestion] extraction/stockage du contenu échoué", err);
    return null;
  }
}
