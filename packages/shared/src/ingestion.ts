import { extractArticle } from "@boreas/content-extractor";
import { sanitizeHtml } from "@boreas/html-sanitizer";
import { and, eq, inArray, isNull, lte, or, type SQL } from "drizzle-orm";
import { articleKey } from "./article-identity";
import {
  chunk,
  insertChunkSize,
  R2_DELETE_CHUNK,
  whereInChunkSize,
} from "./batching";
import { signImageUrl } from "./crypto";
import type { Db } from "./db";
import { articles, feeds, settings } from "./db";
import type { ParsedItem } from "./feed-parser";
import { parseFeed } from "./feed-parser";
import { nowEpochMs, sqlUtcNow } from "./timestamp";
import { writeTombstones } from "./tombstones";

// On dérive la taille de lot d'insertion du nombre de **paramètres liés** posés
// par ligne (limites centralisées dans `batching.ts`) pour qu'elle s'ajuste
// automatiquement si une colonne est ajoutée à `articles`, au lieu d'un nombre
// magique qui dépasserait la limite silencieusement. 11 valeurs explicites + le
// `$defaultFn` d'`updated_at` (#69), que Drizzle lie à l'INSERT, = 12 ; +1 de marge.
const ARTICLE_INSERT_COLUMNS = 13;
const INSERT_CHUNK = insertChunkSize(ARTICLE_INSERT_COLUMNS);

// Concurrence max de l'extraction+sanitization+put R2 par lot. Chaque item
// déclenche un parse linkedom (CPU) + un put R2 (sous-requête) ; un flux peut
// contenir des centaines d'items, donc on borne pour ne pas saturer le budget
// CPU/sous-requêtes du Worker.
const EXTRACT_CONCURRENCY = 6;

// Repli quand `settings.refresh_interval_min` est introuvable (base non seedée).
const DEFAULT_REFRESH_INTERVAL_MIN = 30;

/** Échecs consécutifs à partir desquels un Feed est considéré « en erreur » (#11). */
export const ERROR_THRESHOLD = 3;

// Plafond du backoff exponentiel : un Feed cassé n'est jamais re-vérifié plus
// rarement qu'une fois par 24 h, pour récupérer vite quand il revient (#11).
const MAX_BACKOFF_MIN = 24 * 60;

// Garde-fous fetch (#11) : on borne le nombre de sauts de redirection, la durée
// totale et la taille du corps pour qu'un Feed hostile/cassé ne bloque pas le
// Worker (budget CPU/sous-requêtes) ni ne sature la mémoire.
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 10 * 1024 * 1024;

// Codes de redirection traités comme permanents : la cible devient la nouvelle
// URL du Feed (#11). 302/303/307 sont temporaires et ne modifient pas l'URL.
const PERMANENT_REDIRECTS = new Set([301, 308]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const FETCH_HEADERS = {
  "user-agent": "Boreas/1.0 (+https://boreas.sylvaindenyse.me)",
  accept:
    "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8",
} as const;

/** Corps d'un message de la Queue d'ingestion : le Feed à ingérer (#10, ADR 0002). */
export interface IngestionMessage {
  feedId: string;
  /**
   * Mode de traitement du message (#97). `undefined`/`"ingest"` = ingestion
   * normale (poll : net-new → push) ; `"backfill"` = ré-sanitization en place
   * du contenu des articles déjà stockés (récupération d'embeds, sans net-new
   * ni notification). Optionnel pour rester rétro-compatible avec les messages
   * déjà en vol au déploiement (absent ⇒ ingestion).
   */
  mode?: "ingest" | "backfill";
}

/** Issue d'une ingestion d'un Feed (un message de queue / un refresh manuel). */
export interface IngestResult {
  feedId: string;
  /** `updated` = fetch 2xx traité ; `not_modified` = 304 ; `error` = feed absent / fetch KO. */
  status: "updated" | "not_modified" | "error";
  /** Nouveaux articles réellement insérés (0 si rien de neuf ou 304). */
  inserted: number;
  /**
   * Titres des articles net-new réellement insérés (titres nuls filtrés), pour
   * composer le corps de la notification push (#80). Vide hors `updated`. Peut
   * être plus court que `inserted` si certains net-new n'avaient pas de titre.
   */
  newArticleTitles: string[];
  /** Items présents dans le flux parsé (0 sur 304/erreur) ; sert à détecter un flux illisible. */
  itemCount: number;
  /** Titre du flux après ingestion (évite un re-SELECT à l'appelant). */
  title: string | null;
  error?: string;
  /** Échecs consécutifs après ce passage (0 sur succès) ; ≥ `ERROR_THRESHOLD` = en erreur (#11). */
  consecutiveFailures: number;
}

/** Issue d'un fetch de Feed avec garde-fous (#11). */
export interface FetchFeedResult {
  response: Response;
  /**
   * Corps déjà lu (sous le budget timeout) pour une réponse 2xx, dans la limite
   * de taille ; `null` pour un 304 (sans corps) ou un statut non-2xx (corps non
   * lu). La lecture vit dans `fetchFeed` pour que le timeout couvre aussi le
   * téléchargement, pas seulement les en-têtes.
   */
  bytes: Uint8Array | null;
  /**
   * URL finale atteinte uniquement via des redirections permanentes (301/308) :
   * à persister comme nouvelle URL du Feed. `null` si pas de redirection, ou si
   * la chaîne contenait une redirection temporaire (302/303/307).
   */
  permanentUrl: string | null;
}

// `sendBatch` est plafonné à 100 messages par requête (API Queues).
const QUEUE_BATCH_MAX = 100;

/**
 * Enqueue un message d'ingestion par Feed, en respectant la limite de 100
 * messages par `sendBatch` (API Queues). Partagé par le refresh global (#10),
 * le Cron `scheduled` (ADR 0002) et le backfill (#97).
 *
 * `mode` est porté tel quel dans le corps du message (défaut `"ingest"`) ; le
 * consommateur route ensuite vers l'ingestion ou le backfill (#97).
 */
export async function enqueueFeedIds(
  queue: Pick<Queue<IngestionMessage>, "sendBatch">,
  feedIds: string[],
  mode: IngestionMessage["mode"] = "ingest",
): Promise<void> {
  for (const batch of chunk(feedIds, QUEUE_BATCH_MAX)) {
    await queue.sendBatch(batch.map((feedId) => ({ body: { feedId, mode } })));
  }
}

/**
 * Calcule l'échéance de prochaine vérif d'un Feed : `now + intervalle + jitter`.
 *
 * Le jitter (fraction aléatoire de l'intervalle) étale les échéances des feeds
 * pour qu'ils ne soient pas tous dus au même tick de Cron (ADR 0002 « échéances
 * étalées »).
 *
 * `consecutiveFailures` applique un **backoff exponentiel** (#11) : l'intervalle
 * est multiplié par `2 ^ échecs`, plafonné à 24 h, pour ne pas marteler un Feed
 * cassé. À 0 échec (succès), l'intervalle de base est repris tel quel.
 * Exporté pour test.
 */
export function computeNextCheckAt(
  intervalMinutes: number,
  consecutiveFailures = 0,
  now: Date = new Date(),
): string {
  const backoffMin = Math.min(
    intervalMinutes * 2 ** consecutiveFailures,
    MAX_BACKOFF_MIN,
  );
  const intervalMs = backoffMin * 60_000;
  const jitterMs = Math.floor(Math.random() * intervalMs * 0.25);
  return sqlUtcNow(new Date(now.getTime() + intervalMs + jitterMs));
}

/**
 * Fetch d'un Feed avec garde-fous (#11) : timeout 15 s, ≤ 5 redirections suivies
 * manuellement, corps ≤ 10 Mo. Le suivi manuel (`redirect: "manual"`) est
 * nécessaire pour distinguer une redirection **permanente** (301/308 → l'URL du
 * Feed doit être mise à jour) d'une **temporaire** (302/303/307 → on suit sans
 * réécrire l'URL), ce que `redirect: "follow"` masque.
 *
 * Le corps 2xx est **lu ici**, sous le même `AbortController` : sinon le timeout
 * (annulé au retour) ne couvrirait que les en-têtes et un corps envoyé au
 * compte-gouttes bloquerait le Worker indéfiniment.
 *
 * Lève sur cible de redirection non-http(s) (`bad_redirect`, garde anti-SSRF),
 * dépassement du nombre de redirections (`too_many_redirects`), corps trop gros
 * (`too_large`) ou timeout (`AbortError`, remonté par `fetch`). Exporté pour test.
 */
export async function fetchFeed(
  url: string,
  headers: Record<string, string>,
): Promise<FetchFeedResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let currentUrl = url;
    // `null` dès qu'une redirection temporaire intervient : la chaîne n'est plus
    // « purement permanente », donc on ne réécrit pas l'URL du Feed.
    let permanentUrl: string | null = null;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const response = await fetch(currentUrl, {
        headers,
        redirect: "manual",
        signal: controller.signal,
      });

      if (!REDIRECT_STATUSES.has(response.status)) {
        const bytes = await readBodyWithinLimit(response);
        return { response, bytes, permanentUrl };
      }

      const location = response.headers.get("location");
      if (!location) {
        // Redirection sans cible : on rend la réponse telle quelle (l'appelant
        // la traitera comme un statut non-2xx → erreur).
        return { response, bytes: null, permanentUrl };
      }
      const target = new URL(location, currentUrl);
      // Garde anti-SSRF : on ne suit que http(s) (refuse file:, data:, etc.).
      if (target.protocol !== "http:" && target.protocol !== "https:") {
        throw new Error("bad_redirect");
      }
      currentUrl = target.toString();
      permanentUrl = PERMANENT_REDIRECTS.has(response.status)
        ? currentUrl
        : null;
    }

    throw new Error("too_many_redirects");
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Lit le corps d'une réponse 2xx en bornant la taille (`too_large`) ; renvoie
 * `null` pour un statut non-2xx (corps non pertinent et potentiellement gros —
 * page d'erreur). Vérifie d'abord le `Content-Length` annoncé (rejet en amont),
 * puis la taille réelle après lecture (le header peut mentir/manquer).
 */
async function readBodyWithinLimit(
  response: Response,
): Promise<Uint8Array | null> {
  if (!response.ok) return null;
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > MAX_BODY_BYTES) {
    throw new Error("too_large");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES) throw new Error("too_large");
  return bytes;
}

/** Codes d'erreur de fetch déjà normalisés, levés tels quels par `fetchFeed`. */
const KNOWN_FETCH_ERROR_CODES = new Set([
  "bad_redirect",
  "too_many_redirects",
  "too_large",
]);

/**
 * Normalise une exception du fetch d'un Feed en code d'erreur stable (#11),
 * destiné à `last_error` : un `AbortError` (timeout) devient `timeout`, les
 * erreurs déjà codées par `fetchFeed` (`too_large`…) sont conservées, et toute
 * autre défaillance réseau — dont les messages opaques et variables type
 * « internal error; reference = … » remontés par le runtime — est ramenée à
 * `fetch_failed` plutôt que stockée brute. Les statuts HTTP non-2xx, eux, sont
 * codés en amont (`http_<status>`), hors de ce chemin d'exception. Exporté pour
 * test. (Un `DOMException` n'étant pas partout `instanceof Error`, on lit `name`
 * et `message` par accès direct.)
 */
export function toFeedErrorCode(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const { name, message } = err as { name?: unknown; message?: unknown };
    if (name === "AbortError") return "timeout";
    if (typeof message === "string" && KNOWN_FETCH_ERROR_CODES.has(message)) {
      return message;
    }
  }
  return "fetch_failed";
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
      consecutiveFailures: feeds.consecutive_failures,
    })
    .from(feeds)
    .where(eq(feeds.id, feedId))
    .limit(1);
  if (!feed) {
    return {
      feedId,
      status: "error",
      inserted: 0,
      newArticleTitles: [],
      itemCount: 0,
      title: null,
      error: "feed_not_found",
      consecutiveFailures: 0,
    };
  }

  const intervalMin = await getRefreshIntervalMin(db);

  // Issue de l'ingestion + métadonnées de polling à persister sur le Feed.
  let status: IngestResult["status"] = "updated";
  let error: string | undefined;
  let inserted = 0;
  let newArticleTitles: string[] = [];
  let itemCount = 0;
  let nextEtag = feed.etag;
  let nextLastModified = feed.lastModified;
  let nextTitle = feed.title;
  // Cible d'une redirection permanente (301/308) : à persister comme nouvelle
  // URL du Feed sur tout passage réussi, 304 inclus (#11).
  let redirectedTo: string | null = null;

  try {
    const { response, bytes, permanentUrl } = await fetchFeed(
      feed.url,
      buildConditionalHeaders(feed.etag, feed.lastModified),
    );
    redirectedTo = permanentUrl;

    if (response.status === 304) {
      status = "not_modified";
    } else if (!response.ok || !bytes) {
      status = "error";
      error = `http_${response.status}`;
    } else {
      nextEtag = response.headers.get("etag");
      nextLastModified = response.headers.get("last-modified");
      const parsed = parseFeed(bytes, response.headers.get("content-type"));
      itemCount = parsed.items.length;
      // Le titre du flux peut évoluer ; on le garde à jour (ne l'écrase pas par null).
      if (parsed.title) nextTitle = parsed.title;
      const upserted = await upsertNewArticles(
        db,
        bucket,
        secret,
        feedId,
        feed.url,
        parsed.items,
      );
      inserted = upserted.count;
      newArticleTitles = upserted.titles;
    }
  } catch (err) {
    status = "error";
    error = toFeedErrorCode(err);
    console.error("[ingestion] échec du fetch du flux", feedId, err);
  }

  // Santé du Feed (#11) : un succès (updated/not_modified) remet le compteur à
  // zéro et efface l'erreur ; un échec l'incrémente et pilote le backoff.
  const succeeded = status !== "error";
  const consecutiveFailures = succeeded ? 0 : feed.consecutiveFailures + 1;

  // Toujours avancer les échéances (même 304/erreur), et persister titre +
  // validateurs de cache quand un 200 nous en a donné. Le backoff exponentiel
  // espace les retries d'un Feed cassé (#11). L'URL n'est réécrite que sur un
  // passage réussi (301→200 comme 301→304), jamais vers une cible en échec.
  const nextUrl = await resolvePermanentUrl(
    db,
    feedId,
    feed.url,
    succeeded ? redirectedTo : null,
  );
  await db
    .update(feeds)
    .set({
      url: nextUrl,
      title: nextTitle,
      etag: nextEtag,
      last_modified: nextLastModified,
      last_check_at: sqlUtcNow(),
      next_check_at: computeNextCheckAt(intervalMin, consecutiveFailures),
      consecutive_failures: consecutiveFailures,
      last_error: succeeded ? null : (error ?? "fetch_failed"),
      last_error_at: succeeded ? null : sqlUtcNow(),
    })
    .where(eq(feeds.id, feedId));

  return {
    feedId,
    status,
    inserted,
    newArticleTitles,
    itemCount,
    title: nextTitle,
    error,
    consecutiveFailures,
  };
}

/**
 * Décide de l'URL à persister après une redirection permanente (#11) : adopte
 * `permanentUrl` sauf si un **autre** Feed l'occupe déjà (la colonne `url` est
 * `unique`, l'update échouerait) — dans ce cas on conserve l'URL actuelle et on
 * logge le conflit. Renvoie `currentUrl` si aucune redirection permanente.
 */
async function resolvePermanentUrl(
  db: Db,
  feedId: string,
  currentUrl: string,
  permanentUrl: string | null,
): Promise<string> {
  if (!permanentUrl || permanentUrl === currentUrl) return currentUrl;
  const [clash] = await db
    .select({ id: feeds.id })
    .from(feeds)
    .where(eq(feeds.url, permanentUrl))
    .limit(1);
  if (clash && clash.id !== feedId) {
    console.warn(
      "[ingestion] redirection 301 ignorée : URL déjà abonnée",
      feedId,
      permanentUrl,
    );
    return currentUrl;
  }
  return permanentUrl;
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
    // Un Feed désabonné (#14) est sorti de la sélection : son polling s'arrête.
    .where(
      and(
        isNull(feeds.unsubscribed_at),
        or(isNull(feeds.next_check_at), lte(feeds.next_check_at, nowSql)),
      ),
    );
  return rows.map((r) => r.id);
}

/**
 * Supprime des Articles (et leurs objets R2 de contenu) en respectant la
 * cohérence des deux stores (ADR 0004) : on efface d'abord les objets R2
 * référencés par `content_key`, puis les lignes D1. Réutilisable par le
 * désabonnement et la suppression d'un Feed (#14) comme par la purge de
 * rétention (#15). Renvoie le nombre de lignes supprimées.
 *
 * `where` est la condition Drizzle ciblant les Articles concernés (ex.
 * `eq(articles.feed_id, id)` ou `and(eq(feed_id, id), eq(saved, false))`). Une
 * panne R2 sur un objet ne bloque pas la suppression D1 : les orphelins R2
 * éventuels seront rattrapés par le balayage périodique (#15, ADR 0004).
 *
 * **Chokepoint unique des suppressions d'articles** : on inscrit ici un
 * tombstone par article effacé (#69, ADR 0018), ce qui couvre d'un seul endroit
 * la purge de rétention (#15), la purge des non-Saved au désabonnement (#14) et
 * le Delete destructif d'un Feed — tous les chemins qui faisaient jusqu'ici un
 * hard-delete silencieux. Le tombstone est posé **avant** le DELETE D1 (FK sans
 * effet : `tombstones` est indépendante de `articles`), de sorte qu'une panne du
 * DELETE n'orpheline pas un tombstone sans suppression effective.
 */
export async function deleteArticlesAndContent(
  db: Db,
  bucket: R2Bucket,
  where: SQL,
): Promise<number> {
  const rows = await db
    .select({ id: articles.id, contentKey: articles.content_key })
    .from(articles)
    .where(where);

  const keys = rows
    .map((r) => r.contentKey)
    .filter((k): k is string => k !== null);
  for (const group of chunk(keys, R2_DELETE_CHUNK)) {
    try {
      await bucket.delete(group);
    } catch (err) {
      console.error("[ingestion] suppression d'objets R2 échouée", err);
    }
  }

  // Trace la suppression pour le delta sync avant le hard-delete D1.
  await writeTombstones(
    db,
    "article",
    rows.map((r) => r.id),
  );
  await db.delete(articles).where(where);
  return rows.length;
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
 * n'existe pas déjà pour ce Feed. Renvoie le nombre d'insertions réelles et les
 * titres net-new (titres nuls filtrés), ces derniers servant à composer la
 * notification push de #80.
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
): Promise<{ count: number; titles: string[] }> {
  if (items.length === 0) return { count: 0, titles: [] };

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
  if (fresh.length === 0) return { count: 0, titles: [] };

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
  for (const batch of chunk(fresh, EXTRACT_CONCURRENCY)) {
    rows.push(...(await Promise.all(batch.map(buildRow))));
  }

  // onConflictDoNothing sur (feed_id, article_key) : idempotent et sans reset du
  // Read d'un Article existant. `returning` compte les insertions réelles et
  // remonte leurs titres (net-new) pour la notification push (#80).
  let count = 0;
  const titles: string[] = [];
  for (const group of chunk(rows, INSERT_CHUNK)) {
    const result = await db
      .insert(articles)
      .values(group)
      .onConflictDoNothing()
      .returning({ id: articles.id, title: articles.title });
    count += result.length;
    for (const row of result) if (row.title) titles.push(row.title);
  }
  return { count, titles };
}

/**
 * Extrait (Readability) + sanitize (allow-list, proxy d'images signé) le contenu
 * HTML d'un item. Renvoie le HTML sûr, ou `null` si le flux ne fournit pas de
 * contenu ou si l'extraction/sanitization échoue — **ne touche pas R2**. Le
 * traitement n'est jamais interrompu pour un seul article (try/catch, log).
 *
 * Pur (hors I/O R2) : partagé par l'ingestion ({@link extractAndStore}) et le
 * backfill ({@link backfillFeed}, #97) pour que les règles de sanitization
 * (#94/#95/#96) ne soient jamais dupliquées entre les deux chemins.
 */
function sanitizeArticleContent(
  secret: string,
  rawContent: string | null,
  baseUrl: string | null,
): string | null {
  if (!rawContent) return null;
  try {
    const extracted = extractArticle(rawContent, baseUrl ?? "");
    return sanitizeHtml(extracted.content, {
      baseUrl: baseUrl ?? undefined,
      signImageSrc: (src) => signImageUrl(secret, src),
    });
  } catch (err) {
    console.error(
      "[ingestion] extraction/sanitization du contenu échouée",
      err,
    );
    return null;
  }
}

/** Clé R2 du HTML plein d'un article (ADR 0003/0007). */
const articleContentKey = (id: string) => `articles/${id}.html`;

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
  const safe = sanitizeArticleContent(secret, rawContent, baseUrl);
  if (safe === null) return null;
  try {
    const key = articleContentKey(id);
    await bucket.put(key, safe, {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
    });
    return key;
  } catch (err) {
    console.error("[ingestion] stockage R2 du contenu échoué", err);
    return null;
  }
}

/** Issue d'un backfill d'un Feed (un message de queue `mode:"backfill"`, #97). */
export interface BackfillResult {
  feedId: string;
  /** `updated` = flux re-fetché et traité ; `error` = feed absent / fetch KO. */
  status: "updated" | "error";
  /** Articles existants dont le contenu R2 a été réellement réécrit. */
  rewritten: number;
  /** Items présents dans le flux re-parsé (0 sur erreur). */
  itemCount: number;
  error?: string;
}

/**
 * Backfill d'un Feed (#97) : re-fetche le flux et **ré-sanitize en place** le
 * contenu R2 des articles **déjà stockés**, pour récupérer les embeds que les
 * ingestions passées avaient perdus (le HTML brut n'est pas conservé — ADR 0007 ;
 * seul un re-fetch redonne accès au `content:encoded` d'origine). Symétrique de
 * {@link ingestFeed}, mais en réécriture pure : aucun net-new inséré, aucune
 * notification, et l'état de polling du Feed (etag, échéances, santé) est laissé
 * intact (le backfill ne doit pas perturber le cycle d'ingestion normal).
 *
 * Identité préservée : on ne touche qu'aux articles dont la clé de dédup
 * (`article_key`, ADR 0001) est encore présente dans le flux — `id`, `read`,
 * `saved`, `fetched_at` restent inchangés, aucun doublon n'est créé. `updated_at`
 * est bumpé (#69, ADR 0018) : le contenu a changé, l'article « descend » donc au
 * delta sync. ⚠️ Le lecteur **en ligne** voit aussitôt les embeds (GET
 * /api/articles/:id lit R2 frais) ; le réplica **hors-ligne** ne re-télécharge
 * pas encore le HTML sur simple bump (il ne fetche que le contenu absent du
 * store, cf. `missingContentIds`) — propager le contenu réécrit hors-ligne est
 * un chantier #69 distinct, hors périmètre de #97.
 *
 * **Limite actée** : un item déjà sorti du flux n'a plus de brut récupérable
 * (ADR 0007) — il n'est pas restaurable et est simplement ignoré ici.
 *
 * Borné (garde-fous `fetchFeed` : timeout, taille, redirections) et relançable
 * (idempotent : la ré-sanitization d'un même brut redonne le même HTML).
 */
export async function backfillFeed(
  feedId: string,
  db: Db,
  bucket: R2Bucket,
  secret: string,
): Promise<BackfillResult> {
  // Fabrique locale des retours d'échec (même forme répétée sur chaque sortie).
  const fail = (error: string): BackfillResult => ({
    feedId,
    status: "error",
    rewritten: 0,
    itemCount: 0,
    error,
  });

  const [feed] = await db
    .select({ url: feeds.url })
    .from(feeds)
    .where(eq(feeds.id, feedId))
    .limit(1);
  if (!feed) return fail("feed_not_found");

  let response: Response;
  let bytes: Uint8Array | null;
  try {
    // Pas d'en-têtes conditionnels : on veut le corps même si l'etag matche
    // (un 304 ne nous redonnerait pas le `content:encoded` à ré-sanitizer).
    ({ response, bytes } = await fetchFeed(feed.url, { ...FETCH_HEADERS }));
  } catch (err) {
    console.error("[backfill] échec du fetch du flux", feedId, err);
    return fail(toFeedErrorCode(err));
  }
  if (!response.ok || !bytes) return fail(`http_${response.status}`);

  const parsed = parseFeed(bytes, response.headers.get("content-type"));

  // Articles existants de ce Feed (borné par le nombre d'articles du flux, comme
  // `upsertNewArticles`) : on retient l'id et si le `content_key` était déjà posé.
  const existingRows = await db
    .select({
      id: articles.id,
      key: articles.article_key,
      contentKey: articles.content_key,
    })
    .from(articles)
    .where(eq(articles.feed_id, feedId));
  const byKey = new Map(existingRows.map((r) => [r.key, r]));

  // Items du flux dont l'article existe déjà : seuls candidats au backfill.
  // Dédup intra-flux par id (comme le `seen` d'`upsertNewArticles`) : un flux aux
  // guid dupliqués mapperait sinon plusieurs items vers le même article → puts R2
  // redondants et `rewritten` sur-compté.
  const targets: { id: string; item: ParsedItem; hadContentKey: boolean }[] =
    [];
  const seen = new Set<string>();
  for (const item of parsed.items) {
    const row = byKey.get(articleKey(item, feedId));
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    targets.push({ id: row.id, item, hadContentKey: row.contentKey !== null });
  }

  // Ré-sanitize + réécrit R2 en place, par lots bornés (CPU + sous-requêtes).
  // Garde anti-régression : un contenu désormais vide (extraction infructueuse)
  // ne doit pas **écraser** l'objet R2 existant — on le préserve et on l'ignore.
  const rewriteOne = async (target: (typeof targets)[number]) => {
    const safe = sanitizeArticleContent(
      secret,
      target.item.content,
      target.item.link ?? feed.url,
    );
    // `/\S/` teste la présence d'un caractère non-blanc sans copier la string.
    if (safe === null || !/\S/.test(safe)) return null;
    try {
      await bucket.put(articleContentKey(target.id), safe, {
        httpMetadata: { contentType: "text/html; charset=utf-8" },
      });
      return target;
    } catch (err) {
      console.error("[backfill] réécriture R2 échouée", target.id, err);
      return null;
    }
  };

  // R2 d'abord, D1 ensuite : on ne bumpe `updated_at` que pour les articles dont
  // l'objet R2 a réellement été réécrit (un put en échec ne « descend » pas au delta).
  const rewritten: (typeof targets)[number][] = [];
  for (const batch of chunk(targets, EXTRACT_CONCURRENCY)) {
    const done = await Promise.all(batch.map(rewriteOne));
    for (const t of done) if (t) rewritten.push(t);
  }

  if (rewritten.length > 0) {
    const now = nowEpochMs();
    // Bump `updated_at` (#69) de tous les réécrits : marque le contenu changé au
    // delta sync. Borné sous la limite de variables D1 (1 réservée pour le SET).
    for (const group of chunk(
      rewritten.map((t) => t.id),
      whereInChunkSize(1),
    )) {
      await db
        .update(articles)
        .set({ updated_at: now })
        .where(inArray(articles.id, group));
    }
    // `content_key` n'est posé que pour les articles qui n'en avaient pas
    // (extraction échouée à l'ingestion) : le backfill vient de produire leur
    // contenu. Rare → une écriture par article, via le helper JS partagé avec
    // l'ingestion (pas de schéma de clé R2 dupliqué).
    for (const t of rewritten) {
      if (t.hadContentKey) continue;
      await db
        .update(articles)
        .set({ content_key: articleContentKey(t.id) })
        .where(eq(articles.id, t.id));
    }
  }

  return {
    feedId,
    status: "updated",
    rewritten: rewritten.length,
    itemCount: parsed.items.length,
  };
}
