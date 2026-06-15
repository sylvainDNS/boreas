import { createFileRoute } from "@tanstack/react-router";
import { ArticleListView } from "../components/ArticleListView";
import { validateArticleSearch } from "../lib/article-search";
import { useReplicaSync } from "../lib/sync/use-replica-sync";
import { useArticleView } from "../lib/use-article-view";

/** Vue agrégée d'un Folder : articles de tous ses Feeds (PRD US #17, #13).
 *  Local-first (#73, ADR 0018) : lit le réplica, alimenté par `useReplicaSync`. */
export const Route = createFileRoute("/_shell/folders/$folderId")({
  validateSearch: validateArticleSearch,
  component: FolderView,
});

function FolderView() {
  useReplicaSync();
  const { folderId } = Route.useParams();
  const view = useArticleView({ kind: "folder", folderId });
  return <ArticleListView view={view} />;
}
