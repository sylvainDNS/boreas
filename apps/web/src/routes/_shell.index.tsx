import { createFileRoute } from "@tanstack/react-router";
import { ArticleListView } from "../components/ArticleListView";
import { unreadArticles } from "../mock";

/** Vue d'accueil « Tous les non-lus » (PRD US #18). */
export const Route = createFileRoute("/_shell/")({
  component: () => (
    <ArticleListView
      title="Tous les non-lus"
      articles={unreadArticles()}
      emptyLabel="Tout est lu 🎉"
    />
  ),
});
