import type {
  SyncFeed,
  SyncFolder,
  SyncResponse,
  SyncTombstone,
} from "@boreas/api-contracts";
import {
  articles,
  ERROR_THRESHOLD,
  feeds,
  folders,
  getDb,
  settings,
  tombstones,
} from "@boreas/shared";
import { and, asc, eq, gt } from "drizzle-orm";
import { Hono } from "hono";
import type { Env } from "../env";

/**
 * Taille de page de la sync initiale/incrémentale. La pagination ne porte que sur
 * les **articles** (seule table non bornée) ; feeds/folders/tombstones sont petits
 * et servis en entier à chaque page (idempotent côté réplica).
 */
const PAGE_SIZE = 30;

/** Jours par défaut de la fenêtre de rétention des tombstones (fallback du settings). */
const DEFAULT_PURGE_WINDOW_DAYS = 60;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Routes de sync descendante (montées sur /api/sync), sous le middleware de
 * session. #72 expose le delta lu par le réplica local (ADR 0018).
 */
export const syncRoutes = new Hono<{ Bindings: Env }>();

/**
 * `GET /api/sync?since=<updated_at epoch-ms>` — delta descendant local-first.
 *
 * Renvoie les upserts (articles métadonnées, feeds, folders dont `updated_at >
 * since`) + les tombstones (`deleted_at > since`) + un curseur (borne haute des
 * horodatages servis) à repasser au pull suivant.
 *
 * - `since` absent/0 = **sync initiale complète**, paginée en keyset sur les
 *   articles `(updated_at, id)` pour ne pas charger tout le corpus en mémoire.
 * - `since` antérieur à la **fenêtre de rétention des tombstones** (≈
 *   `settings.purge_window_days`) → réponse `stale: true` : le serveur ne peut
 *   plus garantir l'exhaustivité des suppressions, le client wipe + resync.
 *
 * Le **contenu HTML** et les **images** ne transitent PAS ici (#75/#77).
 */
syncRoutes.get("/", async (c) => {
  const since = parseSince(c.req.query("since"));
  const db = getDb(c.env.DB);

  // Curseur périmé : `since` strictement positif et antérieur à la fenêtre de
  // rétention. Au-delà, le serveur a pu purger des tombstones que le client
  // n'aurait jamais vus → il doit repartir d'une sync initiale complète.
  // `since=0`/absent = sync initiale assumée, jamais périmée.
  if (since > 0) {
    const [row] = await db
      .select({ days: settings.purge_window_days })
      .from(settings)
      .limit(1);
    const windowDays = row?.days ?? DEFAULT_PURGE_WINDOW_DAYS;
    const oldestGuaranteed = Date.now() - windowDays * MS_PER_DAY;
    if (since < oldestGuaranteed) {
      return c.json({
        upserts: { articles: [], feeds: [], folders: [] },
        tombstones: [],
        cursor: null,
        complete: true,
        stale: true,
      } satisfies SyncResponse);
    }
  }

  // --- Articles : seule source paginée (keyset sur updated_at, id) ---
  // On lit PAGE_SIZE+1 lignes ordonnées par (updated_at, id) croissants pour
  // savoir s'il reste une page. Le curseur étant un **timestamp numérique**
  // (`since` est un `updated_at`), on ne coupe jamais un même `updated_at` entre
  // deux pages : sinon le curseur figerait sur ce timestamp sans progresser.
  const pageArticles = await selectArticlePage(db, since);
  const moreAfterCeiling = !pageArticles.complete;

  const upsertArticles = pageArticles.rows.map((row) => ({
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
  }));

  // --- Feeds / Folders / Tombstones : bornés, servis en entier (filtre > since) ---
  const [feedRows, folderRows, tombstoneRows] = await Promise.all([
    db
      .select({
        id: feeds.id,
        url: feeds.url,
        title: feeds.title,
        lastError: feeds.last_error,
        lastCheckAt: feeds.last_check_at,
        folderId: feeds.folder_id,
        unsubscribedAt: feeds.unsubscribed_at,
        consecutiveFailures: feeds.consecutive_failures,
        updatedAt: feeds.updated_at,
      })
      .from(feeds)
      .where(gt(feeds.updated_at, since)),
    db
      .select({
        id: folders.id,
        name: folders.name,
        updatedAt: folders.updated_at,
      })
      .from(folders)
      .where(gt(folders.updated_at, since)),
    db
      .select({
        entityType: tombstones.entity_type,
        entityId: tombstones.entity_id,
        deletedAt: tombstones.deleted_at,
      })
      .from(tombstones)
      .where(gt(tombstones.deleted_at, since)),
  ]);

  const upsertFeeds: SyncFeed[] = feedRows.map((row) => ({
    id: row.id,
    url: row.url,
    title: row.title,
    // Statut santé dérivé des échecs consécutifs (cf. `GET /api/feeds`, #11).
    status: row.consecutiveFailures >= ERROR_THRESHOLD ? "error" : "ok",
    lastError: row.lastError,
    lastCheckAt: row.lastCheckAt,
    folderId: row.folderId,
    unsubscribed: row.unsubscribedAt !== null,
  }));

  const upsertFolders: SyncFolder[] = folderRows.map((row) => ({
    id: row.id,
    name: row.name,
  }));

  const tombstoneItems: SyncTombstone[] = tombstoneRows.map((row) => ({
    entityType: row.entityType,
    entityId: row.entityId,
  }));

  // Curseur = borne haute des horodatages **réellement servis** dans cette page.
  // En pagination, c'est le plafond d'articles (les autres sources re-filtreront
  // par ce since au pull suivant). Sur la page finale, c'est le max global pour
  // que le prochain incrémental soit serré. `null` si la page est vide.
  let cursor: number | null;
  let complete: boolean;
  if (moreAfterCeiling) {
    cursor = pageArticles.cursor;
    complete = false;
  } else {
    // Borne haute des horodatages servis, calculée par réduction linéaire (et non
    // `Math.max(...spread)`) : sur une sync initiale, le corpus de tombstones/feeds
    // peut être assez large pour dépasser la limite d'arguments d'un spread.
    let max: number | null = null;
    const consider = (n: number) => {
      if (max === null || n > max) max = n;
    };
    for (const r of pageArticles.rows) consider(r.updatedAt);
    for (const r of feedRows) consider(r.updatedAt);
    for (const r of folderRows) consider(r.updatedAt);
    for (const r of tombstoneRows) consider(r.deletedAt);
    cursor = max;
    complete = true;
  }

  return c.json({
    upserts: {
      articles: upsertArticles,
      feeds: upsertFeeds,
      folders: upsertFolders,
    },
    tombstones: tombstoneItems,
    cursor,
    complete,
    stale: false,
  } satisfies SyncResponse);
});

/** Parse `since` en epoch-ms ≥ 0 ; toute valeur absente/invalide vaut 0 (initiale). */
function parseSince(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Ligne d'article jointe au Feed, lue pour la page de delta. */
interface ArticleRow {
  id: string;
  feedId: string;
  title: string | null;
  summary: string | null;
  link: string | null;
  publishedAt: string | null;
  fetchedAt: string;
  read: boolean;
  saved: boolean;
  updatedAt: number;
  feedTitle: string | null;
  feedUrl: string;
}

/** Page d'articles + indicateur de complétude + curseur (plafond servi). */
interface ArticlePage {
  rows: ArticleRow[];
  /** `true` quand cette page épuise les articles `> since`. */
  complete: boolean;
  /** Plafond d'`updated_at` servi (à repasser en `since`), si page non finale. */
  cursor: number | null;
}

/** Colonnes de la jointure article→feed, factorisées pour les deux requêtes. */
function articleSelection() {
  return {
    id: articles.id,
    feedId: articles.feed_id,
    title: articles.title,
    summary: articles.summary,
    link: articles.link,
    publishedAt: articles.published_at,
    fetchedAt: articles.fetched_at,
    read: articles.read,
    saved: articles.saved,
    updatedAt: articles.updated_at,
    feedTitle: feeds.title,
    feedUrl: feeds.url,
  };
}

/**
 * Sélectionne une page d'articles `updated_at > since`, **sans scinder un même
 * `updated_at`** entre deux pages (le curseur est un timestamp numérique : couper
 * un timestamp le figerait). Algorithme :
 *
 * 1. Lire PAGE_SIZE+1 lignes par `(updated_at, id)` croissants.
 * 2. Si ≤ PAGE_SIZE : page finale, on sert tout.
 * 3. Sinon, plafond = `updated_at` de la (PAGE_SIZE+1)ᵉ ligne (1ʳᵉ exclue).
 *    - Si des lignes sont strictement `< plafond` : on les sert toutes (elles
 *      tiennent dans la fenêtre lue), curseur = leur max ; la pagination continue
 *      (les lignes au plafond descendront au prochain pull `> curseur`).
 *    - Sinon (toute la fenêtre partage le plafond = gros lot homodaté) : on
 *      sert **toutes** les lignes à ce timestamp exact (requête bornée dédiée),
 *      curseur = plafond ; complet ssi aucune ligne `> plafond`.
 */
async function selectArticlePage(
  db: ReturnType<typeof getDb>,
  since: number,
): Promise<ArticlePage> {
  const rows = (await db
    .select(articleSelection())
    .from(articles)
    .innerJoin(feeds, eq(articles.feed_id, feeds.id))
    .where(gt(articles.updated_at, since))
    .orderBy(asc(articles.updated_at), asc(articles.id))
    .limit(PAGE_SIZE + 1)) as ArticleRow[];

  if (rows.length <= PAGE_SIZE) {
    return { rows, complete: true, cursor: null };
  }

  // La (PAGE_SIZE+1)ᵉ ligne marque le plafond : tout ce qui est strictement
  // en-dessous tient dans la fenêtre lue et peut être servi tel quel.
  const ceiling = rows[PAGE_SIZE]?.updatedAt as number;
  const below = rows.filter((r) => r.updatedAt < ceiling);

  if (below.length > 0) {
    const cursor = Math.max(...below.map((r) => r.updatedAt));
    return { rows: below, complete: false, cursor };
  }

  // Toute la fenêtre partage le même `updated_at` : on doit servir le timestamp
  // entier (la fenêtre PAGE_SIZE+1 n'en a peut-être pas montré toutes les lignes).
  const wholeTimestamp = (await db
    .select(articleSelection())
    .from(articles)
    .innerJoin(feeds, eq(articles.feed_id, feeds.id))
    .where(
      and(gt(articles.updated_at, since), eq(articles.updated_at, ceiling)),
    )
    .orderBy(asc(articles.id))) as ArticleRow[];

  const [moreAbove] = await db
    .select({ id: articles.id })
    .from(articles)
    .where(gt(articles.updated_at, ceiling))
    .limit(1);

  return {
    rows: wholeTimestamp,
    complete: moreAbove === undefined,
    cursor: ceiling,
  };
}
