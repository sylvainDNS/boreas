import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../../lib/api";
import type { Feed } from "../../lib/feeds";
import type { Folder } from "../../lib/folders";
import { stubApi } from "../../test/api-mock";
import { renderWithApp } from "../../test/render";
import { FeedRow } from "./FeedRow";
import type { SidebarDialog } from "./sidebar-model";

vi.mock("../../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedFetch = vi.mocked(apiFetch);

afterEach(() => {
  mockedFetch.mockReset();
});

function makeFeed(over: Partial<Feed> = {}): Feed {
  return {
    id: "f1",
    url: "https://example.com/f1",
    title: "Mon flux",
    status: "ok",
    lastError: null,
    lastCheckAt: null,
    folderId: null,
    ...over,
  };
}

const folders: Folder[] = [
  { id: "tech", name: "Tech", rank: "a0" },
  { id: "perso", name: "Perso", rank: "a1" },
];

function renderRow(
  over: Partial<{
    feed: Feed;
    onRequestDialog: (d: SidebarDialog) => void;
    onMove: (id: string, folderId: string | null) => void;
    unread: number;
    online: boolean;
  }> = {},
) {
  stubApi(mockedFetch, {});
  const onRequestDialog = over.onRequestDialog ?? vi.fn();
  const onMove = over.onMove ?? vi.fn();
  const feed = over.feed ?? makeFeed();
  const result = renderWithApp(
    <FeedRow
      feed={feed}
      unread={over.unread ?? 0}
      folders={folders}
      onRequestDialog={onRequestDialog}
      onMove={onMove}
      online={over.online ?? true}
    />,
    { initialPath: `/feeds/${feed.id}` },
  );
  return { ...result, onRequestDialog, onMove, feed };
}

describe("FeedRow", () => {
  it("marque la ligne active quand la route pointe sur ce feed", async () => {
    renderRow();
    const link = await screen.findByRole("link", { name: /Mon flux/ });
    // L'ancêtre « ligne » porte la classe active.
    expect(link.closest(".bg-surface-2")).not.toBeNull();
  });

  it("affiche le badge d'erreur quand le feed est en erreur", async () => {
    renderRow({ feed: makeFeed({ status: "error", lastError: "http_404" }) });
    expect(
      await screen.findByRole("img", { name: /Flux en erreur \(http_404\)/ }),
    ).toBeInTheDocument();
  });

  it("ouvre « Renommer » via le menu → onRequestDialog(renameFeed)", async () => {
    const { user, onRequestDialog, feed } = renderRow();
    await user.click(
      await screen.findByRole("button", { name: /Actions pour/ }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Renommer…" }));
    expect(onRequestDialog).toHaveBeenCalledWith({ kind: "renameFeed", feed });
  });

  it("« Se désabonner » → onRequestDialog(unsubscribeFeed)", async () => {
    const { user, onRequestDialog, feed } = renderRow();
    await user.click(
      await screen.findByRole("button", { name: /Actions pour/ }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Se désabonner" }));
    expect(onRequestDialog).toHaveBeenCalledWith({
      kind: "unsubscribeFeed",
      feed,
    });
  });

  it("« Supprimer… » → onRequestDialog(deleteFeed)", async () => {
    const { user, onRequestDialog, feed } = renderRow();
    await user.click(
      await screen.findByRole("button", { name: /Actions pour/ }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Supprimer…" }));
    expect(onRequestDialog).toHaveBeenCalledWith({ kind: "deleteFeed", feed });
  });

  it("« Déplacer vers » un dossier → onMove(id, folderId)", async () => {
    const { user, onMove } = renderRow({ feed: makeFeed({ folderId: null }) });
    await user.click(
      await screen.findByRole("button", { name: /Actions pour/ }),
    );
    await user.click(screen.getByRole("menuitem", { name: /Tech/ }));
    expect(onMove).toHaveBeenCalledWith("f1", "tech");
  });

  it("désactive « Aucun dossier » quand le feed n'a déjà pas de dossier", async () => {
    const { user } = renderRow({ feed: makeFeed({ folderId: null }) });
    await user.click(
      await screen.findByRole("button", { name: /Actions pour/ }),
    );
    expect(
      screen.getByRole("menuitem", { name: /Aucun dossier/ }),
    ).toBeDisabled();
  });

  it("hors-ligne : désactive toutes les ops du menu (renommer/déplacer/désabonner/supprimer)", async () => {
    const { user } = renderRow({ online: false });
    await user.click(
      await screen.findByRole("button", { name: /Actions pour/ }),
    );
    expect(screen.getByRole("menuitem", { name: "Renommer…" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: /Tech/ })).toBeDisabled();
    expect(
      screen.getByRole("menuitem", { name: "Se désabonner" }),
    ).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Supprimer…" })).toBeDisabled();
  });
});
