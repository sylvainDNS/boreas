import { createFileRoute } from "@tanstack/react-router";
import { ArticleListView } from "../components/ArticleListView";
import { validateArticleSearch } from "../lib/article-search";
import { useArticleView } from "../lib/use-article-view";

/** Vue d'accueil « Tous les non-lus » (PRD US #18), alimentée par l'API (#6/#8). */
export const Route = createFileRoute("/_shell/")({
  validateSearch: validateArticleSearch,
  component: UnreadView,
});

function UnreadView() {
  const view = useArticleView({ kind: "all" });
  return <ArticleListView view={view} />;
}
