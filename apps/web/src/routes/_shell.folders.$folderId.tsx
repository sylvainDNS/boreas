import { createFileRoute } from "@tanstack/react-router";
import { ArticleListView } from "../components/ArticleListView";
import { articlesByFolder, folderById } from "../mock";

/** Vue agrégée d'un Folder : articles de tous ses Feeds (PRD US #17). */
export const Route = createFileRoute("/_shell/folders/$folderId")({
  component: FolderView,
});

function FolderView() {
  const { folderId } = Route.useParams();
  return (
    <ArticleListView
      title={folderById(folderId)?.name ?? "Dossier introuvable"}
      articles={articlesByFolder(folderId)}
      emptyLabel="Aucun article dans ce dossier."
    />
  );
}
