import { createFileRoute } from "@tanstack/react-router";
import { ArticleListView } from "../components/ArticleListView";
import { useArticleView } from "../lib/use-article-view";

/** Vue des articles Saved (PRD US #30), alimentée par l'API (#9). */
export const Route = createFileRoute("/_shell/saved")({
  component: SavedView,
});

function SavedView() {
  const view = useArticleView({ kind: "saved" });
  return <ArticleListView view={view} />;
}
