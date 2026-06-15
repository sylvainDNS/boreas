import { createFileRoute } from "@tanstack/react-router";
import { ArticleListView } from "../components/ArticleListView";
import { validateArticleSearch } from "../lib/article-search";
import { useReplicaSync } from "../lib/sync/use-replica-sync";
import { useArticleView } from "../lib/use-article-view";

/** Vue des articles Saved (PRD US #30). Local-first (#73, ADR 0018) : lit le
 *  réplica IndexedDB, alimenté par le moteur de sync câblé via `useReplicaSync`. */
export const Route = createFileRoute("/_shell/saved")({
  validateSearch: validateArticleSearch,
  component: SavedView,
});

function SavedView() {
  useReplicaSync();
  const view = useArticleView({ kind: "saved" });
  return <ArticleListView view={view} />;
}
