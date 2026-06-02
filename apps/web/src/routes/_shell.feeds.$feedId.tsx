import { createFileRoute } from "@tanstack/react-router";
import { ArticleListView } from "../components/ArticleListView";
import { articlesByFeed, feedById } from "../mock";

/** Vue filtrée par Feed (PRD US #19). */
export const Route = createFileRoute("/_shell/feeds/$feedId")({
  component: FeedView,
});

function FeedView() {
  const { feedId } = Route.useParams();
  const feed = feedById(feedId);
  return (
    <ArticleListView
      title={feed?.name ?? "Flux introuvable"}
      articles={articlesByFeed(feedId)}
      emptyLabel="Aucun article récent pour ce flux."
    />
  );
}
