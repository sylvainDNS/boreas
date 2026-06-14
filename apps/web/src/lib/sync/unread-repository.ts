import {
  type ArticleCursor,
  type ArticleListResponse,
  decodeArticleCursor,
  encodeArticleCursor,
} from "@boreas/api-contracts";
import type { ReplicaDb } from "./replica-store";

/**
 * Repository local de la river « Tous les non-lus » (#72, ADR 0018). Lit le
 * **réplica IndexedDB** et renvoie **exactement** la forme `ArticleListResponse`
 * (articles wire + `nextCursor`) attendue par `useInfiniteQuery`/`toArticle` :
 * la frontière distant→local se réduit ainsi au `queryFn`, sans toucher au
 * composant ni au modèle de vue.
 *
 * Parité avec `GET /api/articles?filter=unread` :
 *  - **filtre** : `read = false` ET feed non désabonné ;
 *  - **tri** : `coalesce(publishedAt, fetchedAt)` desc puis `id` desc (ADR 0015) ;
 *  - **pagination keyset** : curseur = base64url(`sortKey|id`), identique à l'API,
 *    parcouru via l'index `sortKey` du store sans tout charger en mémoire.
 */

/** Taille de page de la river non-lus locale (identique à l'API). */
export const UNREAD_PAGE_SIZE = 30;

/**
 * Lit une page de non-lus depuis le réplica, du plus récent au plus ancien.
 * `cursor` (issu de la page précédente) reprend la pagination après la dernière
 * clé servie. Renvoie la forme wire `ArticleListResponse`.
 */
export async function readUnreadPage(
  db: ReplicaDb,
  cursor: string | undefined,
): Promise<ArticleListResponse> {
  const after = decodeArticleCursor(cursor);

  // Ensemble des feeds désabonnés : leurs articles sont exclus de la river
  // non-lus (parité API). Petit ensemble (borné par le nb de feeds), lu une fois.
  const feeds = await db.getAll("feeds");
  const unsubscribed = new Set(
    feeds.filter((f) => f.unsubscribed).map((f) => f.id),
  );

  // Parcours de l'index `sortKey` en ordre **décroissant** (river du plus récent
  // au plus ancien). On filtre non-lus + feed actif, et on s'arrête dès qu'on a
  // PAGE_SIZE+1 candidats (la +1ᵉ ligne signale qu'il reste une page).
  const collected: Array<{ sortKey: string; id: string; value: unknown }> = [];
  let articleCursor = await db
    .transaction("articles")
    .objectStore("articles")
    .index("sortKey")
    .openCursor(null, "prev");

  while (articleCursor && collected.length <= UNREAD_PAGE_SIZE) {
    const value = articleCursor.value;
    const sortKey = value.sortKey;
    const id = value.id;
    const keep =
      !value.read &&
      !unsubscribed.has(value.feedId) &&
      isAfter({ sortKey, id }, after);
    if (keep) collected.push({ sortKey, id, value });
    articleCursor = await articleCursor.continue();
  }

  const hasMore = collected.length > UNREAD_PAGE_SIZE;
  const page = hasMore ? collected.slice(0, UNREAD_PAGE_SIZE) : collected;
  const last = page.at(-1);
  const nextCursor =
    hasMore && last ? encodeArticleCursor(last.sortKey, last.id) : null;

  return {
    articles: page.map((row) => stripSortKey(row.value)),
    nextCursor,
  };
}

/** Retire la clé de tri dérivée pour rendre l'item wire (`ArticleListItem`). */
function stripSortKey(value: unknown): ArticleListResponse["articles"][number] {
  const { sortKey: _sortKey, ...item } = value as Record<string, unknown> & {
    sortKey: string;
  };
  return item as ArticleListResponse["articles"][number];
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
