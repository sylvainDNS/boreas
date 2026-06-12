import { createFileRoute } from "@tanstack/react-router";
import { ArticleListView } from "../components/ArticleListView";
import { validateArticleSearch } from "../lib/article-search";
import { useArticleView } from "../lib/use-article-view";

/** Vue agrégée d'un Folder : articles de tous ses Feeds (PRD US #17, #13). */
export const Route = createFileRoute("/_shell/folders/$folderId")({
  validateSearch: validateArticleSearch,
  component: FolderView,
});

function FolderView() {
  const { folderId } = Route.useParams();
  const view = useArticleView({ kind: "folder", folderId });
  return <ArticleListView view={view} />;
}
