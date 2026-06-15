import {
  type ArticleCountsResponse,
  type ArticleCursor,
  type ArticleFilter,
  type ArticleListResponse,
  decodeArticleCursor,
  encodeArticleCursor,
} from "@boreas/api-contracts";
import type { ReplicaArticle, ReplicaDb } from "./replica-store";

/**
 * Repository local des articles (#73, ADR 0018). Généralise la river « Tous les
 * non-lus » (#72) à **toutes** les vues : lit le **réplica IndexedDB** et renvoie
 * **exactement** les formes wire attendues par l'UI (`ArticleListResponse` pour
 * les listes, `ArticleCountsResponse` pour les compteurs) — la frontière
 * distant→local se réduit ainsi au `queryFn`, sans toucher aux composants.
 *
 * Parité avec `GET /api/articles` (`apps/api/src/routes/articles.ts`) :
 *  - **filtre** : `unread`→read=false ; `saved`→saved=true ; `all`→tout ;
 *  - **restriction** : `feedId` (vue par Feed) / `folderId` (vue par Folder,
 *    via `feeds.folderId`) ;
 *  - **feeds désabonnés** : exclus partout **sauf** en vue Saved (un Saved reste
 *    accessible après désabonnement) ;
 *  - **tri** : `coalesce(publishedAt, fetchedAt)` desc puis `id` desc (ADR 0015) ;
 *  - **pagination keyset** : curseur = base64url(`sortKey|id`), codec partagé
 *    `@boreas/api-contracts`, parcouru via l'index `sortKey` du store.
 */

/** Taille de page d'une liste locale (identique à l'API). */
export const ARTICLE_PAGE_SIZE = 30;

/** Portée d'une lecture de liste : filtre + restriction Feed/Folder optionnelle. */
export interface ArticleQuery {
  filter: ArticleFilter;
  feedId?: string;
  folderId?: string;
}

/**
 * Construit le prédicat « cet article entre-t-il dans la vue ? » — la **parité du
 * filtrage** avec l'API, indépendamment du tri/pagination. Capture une fois les
 * ensembles dérivés des feeds (désabonnés, appartenance au folder) pour ne pas
 * relire les métadonnées à chaque article. La règle « feeds désabonnés exclus
 * sauf en Saved » suit exactement `activeFeedScope` de l'API.
 */
function buildArticlePredicate(
  query: ArticleQuery,
  feeds: ReadonlyArray<{
    id: string;
    folderId: string | null;
    unsubscribed: boolean;
  }>,
): (article: ReplicaArticle) => boolean {
  const unsubscribed = new Set(
    feeds.filter((f) => f.unsubscribed).map((f) => f.id),
  );
  // Feeds rattachés au folder ciblé (vue par Folder) : agrège leurs articles,
  // miroir de l'`innerJoin(feeds) where feeds.folder_id = ?` de l'API.
  const folderFeeds =
    query.folderId !== undefined
      ? new Set(
          feeds.filter((f) => f.folderId === query.folderId).map((f) => f.id),
        )
      : null;

  return (a) => {
    if (query.filter === "unread" && a.read) return false;
    if (query.filter === "saved" && !a.saved) return false;
    if (query.feedId !== undefined && a.feedId !== query.feedId) return false;
    if (folderFeeds && !folderFeeds.has(a.feedId)) return false;
    // Feeds désabonnés exclus partout sauf en Saved (parité `activeFeedScope`).
    if (query.filter !== "saved" && unsubscribed.has(a.feedId)) return false;
    return true;
  };
}

/**
 * Lit une page d'articles depuis le réplica selon `query`, du plus récent au plus
 * ancien. `cursor` (issu de la page précédente) reprend la pagination après la
 * dernière clé servie. Renvoie la forme wire `ArticleListResponse`.
 */
export async function readArticlePage(
  db: ReplicaDb,
  query: ArticleQuery,
  cursor: string | undefined,
): Promise<ArticleListResponse> {
  const after = decodeArticleCursor(cursor);
  const feeds = await db.getAll("feeds");
  const matches = buildArticlePredicate(query, feeds);

  // Parcours de l'index `sortKey` en ordre **décroissant** (river du plus récent
  // au plus ancien). On filtre via le prédicat de parité + le keyset, et on
  // s'arrête dès qu'on a PAGE_SIZE+1 candidats (la +1ᵉ ligne signale qu'il reste
  // une page).
  const collected: Array<{
    sortKey: string;
    id: string;
    value: ReplicaArticle;
  }> = [];
  let articleCursor = await db
    .transaction("articles")
    .objectStore("articles")
    .index("sortKey")
    .openCursor(null, "prev");

  while (articleCursor && collected.length <= ARTICLE_PAGE_SIZE) {
    const value = articleCursor.value;
    const sortKey = value.sortKey;
    const id = value.id;
    if (matches(value) && isAfter({ sortKey, id }, after)) {
      collected.push({ sortKey, id, value });
    }
    articleCursor = await articleCursor.continue();
  }

  const hasMore = collected.length > ARTICLE_PAGE_SIZE;
  const page = hasMore ? collected.slice(0, ARTICLE_PAGE_SIZE) : collected;
  const last = page.at(-1);
  const nextCursor =
    hasMore && last ? encodeArticleCursor(last.sortKey, last.id) : null;

  return {
    articles: page.map((row) => stripSortKey(row.value)),
    nextCursor,
  };
}

/**
 * Compteurs de non-lus **exacts**, calculés localement (#73, ADR 0018) : même
 * forme `ArticleCountsResponse` que l'ex-`GET /api/articles/counts`, pour ne pas
 * toucher aux consommateurs (sidebar, `useArticleView`). Parité avec l'endpoint
 * supprimé : non-lus seulement, feeds **actifs**, `byFolder` via `feeds.folderId`
 * (feeds non classés exclus du `byFolder` mais comptés au `total`/`byFeed`).
 *
 * Le `total` se déduit de `byFeed` (toute ligne d'article a un Feed), comme
 * l'API — pas de `byFolder` qui omet les non classés.
 */
export async function localArticleCounts(
  db: ReplicaDb,
): Promise<ArticleCountsResponse> {
  const [articles, feeds] = await Promise.all([
    db.getAll("articles"),
    db.getAll("feeds"),
  ]);
  // Index feed → {folderId, désabonné} : exclusion des feeds désabonnés et
  // rattachement au folder, miroir des jointures SQL des deux agrégats.
  const feedById = new Map(feeds.map((f) => [f.id, f]));

  const byFeedMap = new Map<string, number>();
  const byFolderMap = new Map<string, number>();
  for (const a of articles) {
    if (a.read) continue;
    const feed = feedById.get(a.feedId);
    // Article d'un feed inconnu ou désabonné : exclu (parité `isNull(unsubscribed_at)`).
    if (!feed || feed.unsubscribed) continue;
    byFeedMap.set(a.feedId, (byFeedMap.get(a.feedId) ?? 0) + 1);
    if (feed.folderId != null) {
      byFolderMap.set(feed.folderId, (byFolderMap.get(feed.folderId) ?? 0) + 1);
    }
  }

  const byFeed = [...byFeedMap].map(([feedId, count]) => ({ feedId, count }));
  const byFolder = [...byFolderMap].map(([folderId, count]) => ({
    folderId,
    count,
  }));
  const total = byFeed.reduce((sum, row) => sum + row.count, 0);
  return { total, byFeed, byFolder };
}

/**
 * Recherche **hors-ligne** (#73, ADR 0018) : sous-chaîne **insensible à la casse**
 * dans le **titre** et le **résumé** des articles du réplica. Exclut les feeds
 * désabonnés (cohérent avec les vues/compteurs). Trie comme les listes
 * (`coalesce(publishedAt, fetchedAt)` desc puis id desc, ADR 0015). Une requête
 * vide (ou blancs seuls) renvoie une liste vide. Renvoie des items wire
 * (`ArticleListItem`), prêts pour `toArticle`/`ArticleCard`.
 *
 * Portée délibérément **titre + résumé** (sobre, testable) : le contenu HTML plein
 * vit dans un store séparé (`content`, #75) et seul le corpus non-lus ∪ Saved y est
 * téléchargé ; l'inclure rendrait la recherche partielle et plus coûteuse. À
 * étendre si besoin (cf. rapport — décision UX à valider).
 */
export async function searchArticles(
  db: ReplicaDb,
  query: string,
): Promise<ArticleListResponse["articles"]> {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];

  const [articles, feeds] = await Promise.all([
    db.getAll("articles"),
    db.getAll("feeds"),
  ]);
  const unsubscribed = new Set(
    feeds.filter((f) => f.unsubscribed).map((f) => f.id),
  );

  const matched = articles.filter((a) => {
    // Parité avec la vue Saved : un Saved d'un feed désabonné reste accessible
    // (le désabonnement purge les non-Saved, donc seuls des Saved subsistent d'un
    // feed désabonné). On n'exclut donc que les non-Saved d'un feed désabonné.
    if (unsubscribed.has(a.feedId) && !a.saved) return false;
    const haystack = `${a.title ?? ""}\n${a.summary ?? ""}`.toLowerCase();
    return haystack.includes(needle);
  });

  // Tri décroissant `(sortKey, id)` : même ordre que les listes paginées.
  matched.sort((a, b) => {
    if (a.sortKey !== b.sortKey) return a.sortKey < b.sortKey ? 1 : -1;
    return a.id < b.id ? 1 : -1;
  });

  return matched.map(stripSortKey);
}

/** Retire la clé de tri dérivée pour rendre l'item wire (`ArticleListItem`). */
function stripSortKey(
  value: ReplicaArticle,
): ArticleListResponse["articles"][number] {
  const { sortKey: _sortKey, ...item } = value;
  return item;
}

/**
 * Ordre keyset décroissant : un article passe le curseur s'il est **strictement
 * avant** la dernière clé servie, au sens `(sortKey, id)` décroissant. Reproduit
 * le `or(lt(sortKey), and(eq(sortKey), lt(id)))` SQL de l'API.
 */
function isAfter(
  candidate: ArticleCursor,
  after: ArticleCursor | null,
): boolean {
  if (!after) return true;
  if (candidate.sortKey < after.sortKey) return true;
  if (candidate.sortKey > after.sortKey) return false;
  return candidate.id < after.id;
}
