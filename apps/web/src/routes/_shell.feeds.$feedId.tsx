import { createFileRoute } from "@tanstack/react-router";
import { ArticleListView } from "../components/ArticleListView";
import { validateArticleSearch } from "../lib/article-search";
import { useReplicaSync } from "../lib/sync/use-replica-sync";
import { useArticleView } from "../lib/use-article-view";

/** Vue filtrée par Feed (PRD US #19). Local-first (#73, ADR 0018) : lit le réplica
 *  IndexedDB, alimenté par le moteur de sync câblé via `useReplicaSync`. */
export const Route = createFileRoute("/_shell/feeds/$feedId")({
  validateSearch: validateArticleSearch,
  component: FeedView,
});

function FeedView() {
  useReplicaSync();
  const { feedId } = Route.useParams();
  const view = useArticleView({ kind: "feed", feedId });
  return <ArticleListView view={view} />;
}
