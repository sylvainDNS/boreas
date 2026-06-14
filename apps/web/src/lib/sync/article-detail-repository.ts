import type { ArticleDetailResponse } from "@boreas/api-contracts";
import { type ReplicaDb, readArticleContent } from "./replica-store";

/**
 * Repository local du **détail d'article** (#75, ADR 0018). Lit le lecteur
 * **local-first** : métadonnées depuis le réplica (store `articles`) + HTML
 * depuis le store `content`, et renvoie **exactement** la forme
 * `ArticleDetailResponse` attendue par `articleDetailQueryOptions`/`ReaderPane`
 * — la frontière distant→local se réduit ainsi au `queryFn`, sans toucher au
 * composant.
 *
 * C'est ce qui rend l'ouverture d'un article du corpus offline (non-lus ∪ Saved)
 * **lisible hors-ligne sans l'avoir jamais ouvert** : son contenu a été
 * pré-téléchargé par le moteur de sync (batch sans effet Read).
 */

/**
 * Lit le détail local d'un article, ou `null` si insuffisant pour se rendre
 * local-first :
 *  - **métadonnées absentes** du réplica (article inconnu localement), ou
 *  - **contenu jamais téléchargé** (`undefined` : ni en ligne ni hors-ligne on
 *    n'a rien à montrer) → l'appelant retombe sur l'API (online) en fallback.
 *
 * Un contenu présent mais **`null`** (article sans extraction) est un résultat
 * **valide** : on rend le détail avec `content: null` (le lecteur propose
 * l'original), sans retomber sur l'API.
 */
export async function readArticleDetail(
  db: ReplicaDb,
  id: string,
): Promise<ArticleDetailResponse | null> {
  const meta = await db.get("articles", id);
  if (!meta) return null;

  const html = await readArticleContent(db, id);
  // `undefined` = contenu jamais récupéré : on ne peut rien rendre hors-ligne,
  // l'appelant tentera l'API. `null` (clé présente, sans contenu) est conservé.
  if (html === undefined) return null;

  return {
    id: meta.id,
    feedId: meta.feedId,
    feedName: meta.feedName,
    title: meta.title,
    link: meta.link,
    publishedAt: meta.publishedAt,
    content: html,
    saved: meta.saved,
    // `unread` reflète l'état Read **local** courant (le Read est une mutation
    // client, #75) : cohérent avec ce que le composant affiche déjà du réplica.
    unread: !meta.read,
  };
}
