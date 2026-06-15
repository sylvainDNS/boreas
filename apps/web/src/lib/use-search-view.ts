import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import {
  SEARCH_QUERY_KEY,
  toArticle,
  toggleArticleReadMutationOptions,
  toggleArticleSavedMutationOptions,
} from "./articles";
import { searchArticles } from "./sync/article-repository";
import { getReplica } from "./sync/replica";
import type { ArticleView } from "./use-article-view";

// `SEARCH_QUERY_KEY` est défini dans `articles.ts` (invalidé par les mutations et
// le moteur de sync, sans import circulaire) ; on le ré-exporte ici par commodité.
export { SEARCH_QUERY_KEY };

/**
 * Vue de la **recherche hors-ligne** (#73, ADR 0018). Comme les listes, elle est
 * **local-first** : `searchArticles` scanne le réplica IndexedDB (titre + résumé,
 * insensible à la casse) — aucun appel réseau, aucun endpoint serveur. Produit le
 * même modèle de vue `ArticleView` que `useArticleView` pour réutiliser
 * `ArticleListView`/`ArticleCard`/`ReaderPane` sans adaptation : l'étoile et la
 * bascule lu/non-lu marchent sur les résultats (mutations partagées). Pas de
 * pagination (le scan renvoie tout), ni de « tout marquer lu »/refresh/showRead.
 *
 * `query` vide ⇒ aucune recherche lancée (`enabled: false`) et liste vide : la
 * route affiche alors son invite de saisie.
 */
export function useSearchView(query: string): ArticleView {
  const queryClient = useQueryClient();
  const trimmed = query.trim();

  const search = useQuery({
    queryKey: [...SEARCH_QUERY_KEY, trimmed],
    queryFn: async () => searchArticles(await getReplica(), trimmed),
    enabled: trimmed.length > 0,
  });

  const toggleRead = useMutation(toggleArticleReadMutationOptions(queryClient));
  const toggleSaved = useMutation(
    toggleArticleSavedMutationOptions(queryClient),
  );

  const articles = useMemo(
    () => (search.data ?? []).map(toArticle),
    [search.data],
  );

  const onToggleRead = useCallback(
    (id: string, read: boolean) => toggleRead.mutate({ id, read }),
    [toggleRead],
  );
  const onToggleSaved = useCallback(
    (id: string, saved: boolean) => toggleSaved.mutate({ id, saved }),
    [toggleSaved],
  );

  return {
    title: trimmed ? `Recherche : « ${trimmed} »` : "Recherche",
    emptyLabel: trimmed
      ? "Aucun article ne correspond à cette recherche."
      : "Tapez une recherche pour explorer vos articles.",
    articles,
    isLoading: search.isFetching,
    isError: search.isError,
    hasNextPage: false,
    isFetchingNextPage: false,
    onEndReached: () => {},
    onToggleRead,
    onToggleSaved,
  };
}
