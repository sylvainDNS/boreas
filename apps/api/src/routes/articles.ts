import { articles, feeds, getDb } from "@boreas/shared";
import { and, desc, eq, lt, or } from "drizzle-orm";
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
 * Liste paginée des articles non-lus, du plus récent au plus ancien.
 *
 * Pagination **keyset** sur `(fetched_at desc, id desc)` : le curseur encode le
 * dernier `(fetched_at, id)` servi, évitant les sauts/doublons d'une pagination
 * par offset quand de nouveaux articles arrivent.
 */
articlesRoutes.get("/", async (c) => {
  const filter = c.req.query("filter") ?? "unread";
  // #6 ne sert que les non-lus ; les autres filtres arrivent en #8/#9.
  if (filter !== "unread") {
    return c.json({ error: "unsupported_filter" }, 400);
  }

  const cursor = decodeCursor(c.req.query("cursor"));
  const keyset = cursor
    ? or(
        lt(articles.fetched_at, cursor.fetchedAt),
        and(
          eq(articles.fetched_at, cursor.fetchedAt),
          lt(articles.id, cursor.id),
        ),
      )
    : undefined;

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
      fetchedAt: articles.fetched_at,
      feedTitle: feeds.title,
      feedUrl: feeds.url,
    })
    .from(articles)
    .innerJoin(feeds, eq(articles.feed_id, feeds.id))
    .where(and(eq(articles.read, false), keyset))
    .orderBy(desc(articles.fetched_at), desc(articles.id))
    .limit(PAGE_SIZE + 1);

  // La (PAGE_SIZE+1)ᵉ ligne signale qu'il reste une page : on la retire et on
  // calcule le curseur sur la dernière ligne effectivement servie.
  const hasMore = rows.length > PAGE_SIZE;
  const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
  const last = page.at(-1);
  const nextCursor =
    hasMore && last ? encodeCursor(last.fetchedAt, last.id) : null;

  return c.json({
    articles: page.map((row) => ({
      id: row.id,
      feedId: row.feedId,
      feedName: row.feedTitle ?? row.feedUrl,
      title: row.title,
      summary: row.summary,
      link: row.link,
      publishedAt: row.publishedAt,
      read: row.read,
    })),
    nextCursor,
  });
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
  });
});

interface Cursor {
  fetchedAt: string;
  id: string;
}

function encodeCursor(fetchedAt: string, id: string): string {
  return toBase64Url(`${fetchedAt}|${id}`);
}

function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const decoded = fromBase64Url(raw);
    const sep = decoded.indexOf("|");
    if (sep === -1) return null;
    return { fetchedAt: decoded.slice(0, sep), id: decoded.slice(sep + 1) };
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
