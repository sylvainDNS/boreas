import { createFileRoute } from "@tanstack/react-router";
import { ArticleListView } from "../components/ArticleListView";
import { savedArticles } from "../mock";

/** Vue des articles Saved (PRD US #30). */
export const Route = createFileRoute("/_shell/saved")({
  component: () => (
    <ArticleListView
      title="Saved"
      articles={savedArticles()}
      emptyLabel="Aucun article sauvegardé pour l'instant."
    />
  ),
});
