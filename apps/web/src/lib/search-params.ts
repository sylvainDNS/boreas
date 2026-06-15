import { type ArticleSearch, validateArticleSearch } from "./article-search";

/**
 * Search params de la route de recherche `/search` (#73, ADR 0018) : la requête
 * texte `?q=<query>` **plus** le `?article=<id>` partagé par toutes les vues liste
 * (le lecteur s'ouvre depuis un résultat de recherche comme depuis n'importe quelle
 * liste). On compose `validateArticleSearch` pour ne pas dupliquer la normalisation
 * de `?article`.
 *
 * La requête vide/absente est normalisée en param **omis** (URL propre) : la route
 * affiche alors l'invite « tapez pour rechercher » plutôt qu'une liste vide.
 */
export interface SearchPageSearch extends ArticleSearch {
  /** Requête texte de recherche, ou absente si aucune. */
  q?: string;
}

export function validateSearchPageSearch(
  search: Record<string, unknown>,
): SearchPageSearch {
  const base = validateArticleSearch(search);
  const q = search.q;
  return typeof q === "string" && q.trim().length > 0 ? { ...base, q } : base;
}
