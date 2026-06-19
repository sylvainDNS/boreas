import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../../lib/api";
import type { Feed } from "../../lib/feeds";
import type { Folder } from "../../lib/folders";
import { stubApi } from "../../test/api-mock";
import { renderWithApp } from "../../test/render";
import { FolderTree } from "./FolderTree";
import { groupFeedsByFolder, type SidebarDialog } from "./sidebar-model";

vi.mock("../../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedFetch = vi.mocked(apiFetch);

afterEach(() => {
  mockedFetch.mockReset();
});

function makeFeed(id: string, folderId: string | null): Feed {
  return {
    id,
    url: `https://example.com/${id}`,
    title: id,
    status: "ok",
    lastError: null,
    lastCheckAt: null,
    folderId,
    rank: "a0",
  };
}

function renderTree(
  over: Partial<{
    folders: Folder[];
    feeds: Feed[];
    onRequestDialog: (d: SidebarDialog) => void;
    online: boolean;
    unreadByFolder: Map<string, number>;
  }> = {},
) {
  stubApi(mockedFetch, {});
  const folders = over.folders ?? [{ id: "tech", name: "Tech", rank: "a0" }];
  const feeds = over.feeds ?? [makeFeed("f1", "tech"), makeFeed("u1", null)];
  const { feedsByFolder, unfiledFeeds } = groupFeedsByFolder(folders, feeds);
  const onRequestDialog = over.onRequestDialog ?? vi.fn();
  const result = renderWithApp(
    <FolderTree
      folders={folders}
      feedsByFolder={feedsByFolder}
      unfiledFeeds={unfiledFeeds}
      feedsCount={feeds.length}
      unreadByFeed={new Map()}
      unreadByFolder={over.unreadByFolder ?? new Map([["tech", 3]])}
      onRequestDialog={onRequestDialog}
      online={over.online ?? true}
    />,
  );
  return { ...result, onRequestDialog };
}

describe("FolderTree", () => {
  it("dossier avec non-lus : point « non lu » et nom en gras, sans chiffre", async () => {
    renderTree();
    const label = await screen.findByText("Tech");
    expect(label.className).toContain("font-medium");
    expect(screen.getByLabelText("non lu")).toBeInTheDocument();
    // Plus de pilule compteur sur le dossier.
    expect(screen.queryByText("3")).toBeNull();
  });

  it("dossier tout lu : pas de point et nom grisé", async () => {
    renderTree({
      folders: [{ id: "tech", name: "Tech", rank: "a0" }],
      unreadByFolder: new Map(),
    });
    const label = await screen.findByText("Tech");
    expect(label.className).toContain("text-muted");
    expect(screen.queryByLabelText("non lu")).toBeNull();
  });

  it("replie puis déplie un dossier (les feeds disparaissent/réapparaissent)", async () => {
    const { user } = renderTree();
    expect(await screen.findByRole("link", { name: /f1/ })).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Replier le dossier" }),
    );
    expect(screen.queryByRole("link", { name: /f1/ })).toBeNull();

    await user.click(
      screen.getByRole("button", { name: "Déplier le dossier" }),
    );
    expect(screen.getByRole("link", { name: /f1/ })).toBeInTheDocument();
  });

  it("liste les feeds sans dossier dans la section Flux", async () => {
    renderTree();
    expect(await screen.findByRole("link", { name: /u1/ })).toBeInTheDocument();
  });

  it("affiche l'état vide quand il n'y a aucun dossier", async () => {
    renderTree({ folders: [], feeds: [makeFeed("u1", null)] });
    expect(await screen.findByText("Aucun dossier.")).toBeInTheDocument();
  });

  it("affiche « Dossier vide. » pour un dossier sans feed", async () => {
    renderTree({
      folders: [{ id: "tech", name: "Tech", rank: "a0" }],
      feeds: [],
    });
    expect(await screen.findByText("Dossier vide.")).toBeInTheDocument();
  });

  it("le « + » dossier demande le dialogue createFolder", async () => {
    const { user, onRequestDialog } = renderTree();
    await user.click(
      await screen.findByRole("button", { name: "Nouveau dossier" }),
    );
    expect(onRequestDialog).toHaveBeenCalledWith({ kind: "createFolder" });
  });

  it("le « + » flux demande le dialogue addFeed", async () => {
    const { user, onRequestDialog } = renderTree();
    await user.click(
      await screen.findByRole("button", { name: "Ajouter un flux" }),
    );
    expect(onRequestDialog).toHaveBeenCalledWith({ kind: "addFeed" });
  });

  it("affiche l'état vide global quand il n'y a aucun feed", async () => {
    renderTree({ folders: [], feeds: [] });
    expect(
      await screen.findByText("Aucun flux pour l'instant."),
    ).toBeInTheDocument();
  });

  it("hors-ligne : désactive les « + » (nouveau dossier / ajouter un flux)", async () => {
    renderTree({ online: false });
    expect(
      await screen.findByRole("button", { name: "Nouveau dossier" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Ajouter un flux" }),
    ).toBeDisabled();
  });

  it("hors-ligne : désactive renommer/supprimer un dossier", async () => {
    const { user } = renderTree({ online: false });
    await user.click(
      await screen.findByRole("button", { name: /Actions pour Tech/ }),
    );
    expect(screen.getByRole("menuitem", { name: "Renommer…" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Supprimer" })).toBeDisabled();
  });
});
