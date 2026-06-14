import { createFileRoute } from "@tanstack/react-router";
import { ArticleListView } from "../components/ArticleListView";
import { validateArticleSearch } from "../lib/article-search";
import { useReplicaSync } from "../lib/sync/use-replica-sync";
import { useArticleView } from "../lib/use-article-view";

/**
 * Vue d'accueil « Tous les non-lus » (PRD US #18). Local-first (#72, ADR 0018) :
 * le filtre `unread` lit le réplica IndexedDB (cf. `listArticlesInfiniteQueryOptions`),
 * alimenté par le moteur de sync câblé ici via `useReplicaSync` (focus/online/
 * intervalle) — la vue n'appelle plus l'API directement pour les non-lus.
 */
export const Route = createFileRoute("/_shell/")({
  validateSearch: validateArticleSearch,
  component: UnreadView,
});

/** Composant de la vue, exporté pour les tests d'intégration SPA. */
export function UnreadView() {
  useReplicaSync();
  const view = useArticleView({ kind: "all" });
  return <ArticleListView view={view} />;
}
