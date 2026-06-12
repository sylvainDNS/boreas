/**
 * Search param `?article=<id>` partagé par les 4 vues liste (`/`, `/feeds/$feedId`,
 * `/folders/$folderId`, `/saved`). Encode l'**Article ouvert** dans l'URL : le
 * back système ramène à la liste et l'Article devient deep-linkable (ADR 0016).
 *
 * `validateSearch` côté TanStack Router : on normalise un id absent/vide en
 * `{}` (param omis) plutôt qu'en chaîne vide, pour une URL propre.
 */
export interface ArticleSearch {
  /** Id de l'Article ouvert dans le lecteur, ou absent si aucun. */
  article?: string;
}

export function validateArticleSearch(
  search: Record<string, unknown>,
): ArticleSearch {
  const article = search.article;
  return typeof article === "string" && article.length > 0 ? { article } : {};
}
