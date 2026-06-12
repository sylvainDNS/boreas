import { createFileRoute } from "@tanstack/react-router";
import { ArticleListView } from "../components/ArticleListView";
import { validateArticleSearch } from "../lib/article-search";
import { useArticleView } from "../lib/use-article-view";

/** Vue filtrée par Feed (PRD US #19), alimentée par l'API (#11). */
export const Route = createFileRoute("/_shell/feeds/$feedId")({
  validateSearch: validateArticleSearch,
  component: FeedView,
});

function FeedView() {
  const { feedId } = Route.useParams();
  const view = useArticleView({ kind: "feed", feedId });
  return <ArticleListView view={view} />;
}
