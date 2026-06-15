import { createFileRoute, useSearch } from "@tanstack/react-router";
import { ArticleListView } from "../components/ArticleListView";
import {
  type SearchPageSearch,
  validateSearchPageSearch,
} from "../lib/search-params";
import { useReplicaSync } from "../lib/sync/use-replica-sync";
import { useSearchView } from "../lib/use-search-view";

/**
 * Vue de recherche (#73, ADR 0018). **Hors-ligne** : `useSearchView` scanne le
 * réplica IndexedDB (aucun endpoint serveur). La requête vit dans l'URL (`?q=`,
 * comme `?article=`) → la recherche est deep-linkable et le back système la
 * conserve. `useReplicaSync` garde le réplica frais quand on est en ligne.
 */
export const Route = createFileRoute("/_shell/search")({
  validateSearch: validateSearchPageSearch,
  component: SearchView,
});

/**
 * Composant de la vue, exporté pour les tests d'intégration SPA. Lit `?q` via
 * `useSearch({ strict: false })` (comme `ArticleListView` lit `?article`) pour se
 * monter sans dépendre de l'augmentation de module de `routeTree.gen.ts` (harness
 * de test).
 */
export function SearchView() {
  useReplicaSync();
  const { q = "" } = useSearch({ strict: false }) as SearchPageSearch;
  const view = useSearchView(q);
  return <ArticleListView view={view} />;
}
