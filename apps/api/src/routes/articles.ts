import {
  type ArticleCountsResponse,
  type ArticleDetailResponse,
  type ArticleListResponse,
  type ArticlePatchResponse,
  articleFilterSchema,
  articlePatchSchema,
  type MarkReadResponse,
  markReadRequestSchema,
} from "@boreas/api-contracts";
import { articles, feeds, getDb } from "@boreas/shared";
import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { Hono } from "hono";
import type { Env } from "../env";

/** Taille de page de la liste « Tous les non-lus ». */
const PAGE_SIZE = 30;

/**
 * Routes Article (montées sur /api/articles), sous le middleware de session.
 * #6 expose la vue « Tous les non-lus », paginée en keyset.
 */
export const articlesRoutes = new Hono<{ Bindings: Env }>();

/**
 * Liste paginée des articles, du plus récent au plus ancien.
 *
 * `filter=unread` (défaut) ne sert que les non-lus ; `filter=all` sert lus +
 * non-lus (#8, US 20). Tri par **date de publication** décroissante, avec
 * fallback sur `fetched_at` quand le flux ne fournit pas de date (ADR 0015).
 * Pagination **keyset** sur `(COALESCE(published_at, fetched_at) desc, id desc)` :
 * le curseur encode la dernière clé de tri servie, évitant les sauts/doublons
 * d'une pagination par offset quand de nouveaux articles arrivent.
 */
articlesRoutes.get("/", async (c) => {
  const filterResult = articleFilterSchema.safeParse(
    c.req.query("filter") ?? "unread",
  );
  if (!filterResult.success) {
    return c.json({ error: "unsupported_filter" }, 400);
  }
  const filter = filterResult.data;

  // Clé de tri : date de publication, ou date d'ingestion à défaut. `fetched_at`
  // étant NOT NULL, l'expression est toujours non-null (ADR 0015).
  const sortKey = sql<string>`coalesce(${articles.published_at}, ${articles.fetched_at})`;

  const cursor = decodeCursor(c.req.query("cursor"));
  const keyset = cursor
    ? or(
        lt(sortKey, cursor.sortKey),
        and(eq(sortKey, cursor.sortKey), lt(articles.id, cursor.id)),
      )
    : undefined;
  // `filter=unread` ne sert que les non-lus ; `filter=saved` ne sert que les
  // Saved (#9) ; `filter=all` lève tout prédicat pour servir aussi les lus.
  const scope =
    filter === "unread"
      ? eq(articles.read, false)
      : filter === "saved"
        ? eq(articles.saved, true)
        : undefined;

  // Restriction optionnelle à un Feed (#11, vue `/feeds/$feedId`).
  const feedId = c.req.query("feedId");
  const feedScope = feedId ? eq(articles.feed_id, feedId) : undefined;

  // Restriction optionnelle à un Folder (#13, vue `/folders/$folderId`) : agrège
  // les articles de tous les Feeds rattachés, via le `innerJoin(feeds)` ci-dessous.
  const folderId = c.req.query("folderId");
  const folderScope = folderId ? eq(feeds.folder_id, folderId) : undefined;

  // Les Articles d'un Feed désabonné (#14) sont exclus de la river non-lus et de
  // « tout afficher », cohérent avec la sidebar. La vue Saved, elle, les garde :
  // un Saved doit rester accessible même après désabonnement du Feed.
  const activeFeedScope =
    filter === "saved" ? undefined : isNull(feeds.unsubscribed_at);

  const db = getDb(c.env.DB);
  const rows = await db
    .select({
      id: articles.id,
      feedId: articles.feed_id,
      title: articles.title,
      summary: articles.summary,
      link: articles.link,
      publishedAt: articles.published_at,
      read: articles.read,
      saved: articles.saved,
      fetchedAt: articles.fetched_at,
      feedTitle: feeds.title,
      feedUrl: feeds.url,
    })
    .from(articles)
    .innerJoin(feeds, eq(articles.feed_id, feeds.id))
    .where(and(scope, feedScope, folderScope, keyset, activeFeedScope))
    .orderBy(desc(sortKey), desc(articles.id))
    .limit(PAGE_SIZE + 1);

  // La (PAGE_SIZE+1)ᵉ ligne signale qu'il reste une page : on la retire et on
  // calcule le curseur sur la dernière ligne effectivement servie. La clé de
  // tri du curseur doit reproduire le `coalesce` SQL : `publishedAt ?? fetchedAt`.
  const hasMore = rows.length > PAGE_SIZE;
  const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
  const last = page.at(-1);
  const nextCursor =
    hasMore && last
      ? encodeCursor(last.publishedAt ?? last.fetchedAt, last.id)
      : null;

  return c.json({
    articles: page.map((row) => ({
      id: row.id,
      feedId: row.feedId,
      feedName: row.feedTitle ?? row.feedUrl,
      title: row.title,
      summary: row.summary,
      link: row.link,
      publishedAt: row.publishedAt,
      fetchedAt: row.fetchedAt,
      read: row.read,
      saved: row.saved,
    })),
    nextCursor,
  } satisfies ArticleListResponse);
});

/**
 * Compteurs de non-lus exacts : total global + agrégat par Feed (#8) et par
 * Folder (#13). Le SPA y lit le badge « Tous les non-lus » et les pastilles de
 * la sidebar (exact, indépendamment des pages chargées). Les Feeds/Folders sans
 * non-lu n'apparaissent pas dans `byFeed`/`byFolder`.
 *
 * `byFolder` joint `feeds` pour remonter `folder_id` ; les articles de Feeds non
 * classés (`folder_id` null) en sont exclus. Le `total` se déduit de `byFeed`
 * (toute ligne d'article a un Feed), pas de `byFolder` qui omet les non classés.
 *
 * Déclaré **avant** `GET /:id` pour que `/counts` ne soit pas capturé comme un id.
 */
articlesRoutes.get("/counts", async (c) => {
  const db = getDb(c.env.DB);
  // Les Feeds désabonnés (#14) sont exclus des compteurs (jointure + filtre),
  // pour rester cohérents avec la sidebar et la river non-lus. Les deux agrégats
  // sont indépendants : on les lance en parallèle (endpoint chaud, polling).
  const [byFeed, byFolder] = await Promise.all([
    db
      .select({ feedId: articles.feed_id, count: count() })
      .from(articles)
      .innerJoin(feeds, eq(articles.feed_id, feeds.id))
      .where(and(eq(articles.read, false), isNull(feeds.unsubscribed_at)))
      .groupBy(articles.feed_id),
    db
      .select({ folderId: feeds.folder_id, count: count() })
      .from(articles)
      .innerJoin(feeds, eq(articles.feed_id, feeds.id))
      .where(
        and(
          eq(articles.read, false),
          isNotNull(feeds.folder_id),
          isNull(feeds.unsubscribed_at),
        ),
      )
      .groupBy(feeds.folder_id),
  ]);

  const total = byFeed.reduce((sum, row) => sum + row.count, 0);
  // `isNotNull(feeds.folder_id)` garantit déjà le non-null au runtime ; drizzle
  // infère pourtant `string | null`. On restreint via un garde de type (et non un
  // cast) : le contrat wire impose un `folderId` non-null, et si un futur refactor
  // relâchait le `isNotNull` ci-dessus, les `null` seraient exclus plutôt que
  // faussement présentés comme des chaînes.
  const byFolderResult = byFolder.filter(
    (row): row is { folderId: string; count: number } => row.folderId !== null,
  );
  return c.json({
    total,
    byFeed,
    byFolder: byFolderResult,
  } satisfies ArticleCountsResponse);
});

/**
 * Bascule manuelle de l'état d'un Article (#8/#9) : `read` (lu↔non-lu) et/ou
 * `saved` (sauvé↔non-sauvé), indépendamment de l'ouverture. Au moins un champ
 * doit être fourni ; la réponse n'écho que les champs effectivement modifiés.
 */
articlesRoutes.patch("/:id", async (c) => {
  const parsed = articlePatchSchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return c.json({ error: "invalid_request" }, 400);
  }
  const id = c.req.param("id");
  const db = getDb(c.env.DB);

  // `parsed.data` ne contient que les champs réellement fournis (zod `.optional`
  // n'injecte pas les clés absentes) et `.refine` en garantit au moins un : on
  // l'utilise directement comme jeu de colonnes à mettre à jour et comme écho.
  const updated = await db
    .update(articles)
    .set(parsed.data)
    .where(eq(articles.id, id))
    .returning({ id: articles.id });

  if (updated.length === 0) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.json({ id, ...parsed.data } satisfies ArticlePatchResponse);
});

/**
 * « Tout marquer lu » (#8) au niveau global, d'un Feed ou d'un Folder (#13). La
 * portée Folder cible les articles des Feeds rattachés via un sous-`select` sur
 * `feeds.folder_id`. On ne touche que les non-lus pour que `updated` reflète le
 * nombre réel d'articles basculés.
 */
articlesRoutes.post("/mark-read", async (c) => {
  const parsed = markReadRequestSchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return c.json({ error: "invalid_request" }, 400);
  }
  const db = getDb(c.env.DB);

  const scopeFilter =
    parsed.data.scope === "feed"
      ? eq(articles.feed_id, parsed.data.feedId)
      : parsed.data.scope === "folder"
        ? inArray(
            articles.feed_id,
            db
              .select({ id: feeds.id })
              .from(feeds)
              .where(eq(feeds.folder_id, parsed.data.folderId)),
          )
        : undefined;

  const updated = await db
    .update(articles)
    .set({ read: true })
    .where(and(eq(articles.read, false), scopeFilter))
    .returning({ id: articles.id });

  return c.json({ updated: updated.length } satisfies MarkReadResponse);
});

/**
 * Sert le contenu plein d'un Article : métadonnées (D1) + HTML extrait/sanitizé
 * (R2, écrit à l'ingestion, ADR 0003/0004). Ouvrir l'article le **marque Read**
 * (#7) ; le toggle manuel explicite arrive en #8. `content` vaut `null` si
 * l'extraction n'a rien produit (le SPA propose alors l'original).
 */
articlesRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c.env.DB);

  const [row] = await db
    .select({
      id: articles.id,
      title: articles.title,
      link: articles.link,
      publishedAt: articles.published_at,
      contentKey: articles.content_key,
      read: articles.read,
      saved: articles.saved,
      feedTitle: feeds.title,
      feedUrl: feeds.url,
    })
    .from(articles)
    .innerJoin(feeds, eq(articles.feed_id, feeds.id))
    .where(eq(articles.id, id))
    .limit(1);

  if (!row) {
    return c.json({ error: "not_found" }, 404);
  }

  // Un objet R2 absent (extraction sans contenu) ou une panne R2 transitoire ne
  // doivent pas faire échouer la lecture : on dégrade en `content: null` (le SPA
  // propose alors l'original) plutôt que de renvoyer une 500.
  let content: string | null = null;
  if (row.contentKey) {
    try {
      const obj = await c.env.BUCKET.get(row.contentKey);
      content = obj ? await obj.text() : null;
    } catch (err) {
      console.error("[articles] lecture du contenu R2 échouée", err);
    }
  }

  // Marque Read à l'ouverture (#7) ; on évite une écriture inutile si déjà lu.
  if (!row.read) {
    await db.update(articles).set({ read: true }).where(eq(articles.id, id));
  }

  return c.json({
    id: row.id,
    feedName: row.feedTitle ?? row.feedUrl,
    title: row.title,
    link: row.link,
    publishedAt: row.publishedAt,
    content,
    saved: row.saved,
    // `unread` AVANT le marquage Read ci-dessus : le client sait ainsi si
    // l'Article « était non-lu » pour invalider les compteurs.
    unread: !row.read,
  } satisfies ArticleDetailResponse);
});

interface Cursor {
  /** Clé de tri du dernier article servi : `coalesce(published_at, fetched_at)`. */
  sortKey: string;
  id: string;
}

function encodeCursor(sortKey: string, id: string): string {
  return toBase64Url(`${sortKey}|${id}`);
}

function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const decoded = fromBase64Url(raw);
    const sep = decoded.indexOf("|");
    if (sep === -1) return null;
    return { sortKey: decoded.slice(0, sep), id: decoded.slice(sep + 1) };
  } catch {
    return null;
  }
}

function toBase64Url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return atob(padded);
}
