import { screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../../lib/api";
import type { Feed } from "../../lib/feeds";
import type { Folder } from "../../lib/folders";
import type { ApiHandlerContext } from "../../test/api-mock";
import { stubApi } from "../../test/api-mock";
import { renderWithApp } from "../../test/render";
import { SidebarDialogs } from "./SidebarDialogs";
import type { SidebarDialog } from "./sidebar-model";
import { useFeedLifecycle } from "./use-feed-lifecycle";

/**
 * Harness local : câble le hook `useFeedLifecycle` (requis pour les mutations
 * désabonnement/suppression) et ouvre un dialogue initial.
 */
function SidebarDialogsHarness({
  initialDialog,
  online = true,
}: {
  initialDialog: SidebarDialog;
  online?: boolean;
}) {
  const [dialog, setDialog] = useState<SidebarDialog | null>(initialDialog);
  const { unsubscribe, remove } = useFeedLifecycle();
  return (
    <SidebarDialogs
      dialog={dialog}
      onClose={() => setDialog(null)}
      unsubscribe={unsubscribe}
      remove={remove}
      online={online}
    />
  );
}

vi.mock("../../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedFetch = vi.mocked(apiFetch);

afterEach(() => {
  mockedFetch.mockReset();
});

const feed: Feed = {
  id: "f1",
  url: "https://example.com/f1",
  title: "Mon flux",
  status: "ok",
  lastError: null,
  lastCheckAt: null,
  folderId: null,
};
const folder: Folder = { id: "fold", name: "Tech", rank: "a0" };

describe("SidebarDialogs", () => {
  it("crée un dossier (POST /folders) puis ferme", async () => {
    let received: unknown;
    stubApi(mockedFetch, {
      "POST /folders": ({ body }: ApiHandlerContext) => {
        received = body;
        return { id: "new", name: "Sport" };
      },
    });
    const { user } = renderWithApp(
      <SidebarDialogsHarness initialDialog={{ kind: "createFolder" }} />,
    );

    const input = await screen.findByLabelText("Nom du dossier");
    await user.type(input, "Sport");
    await user.click(screen.getByRole("button", { name: "Créer" }));

    await waitFor(() => expect(received).toEqual({ name: "Sport" }));
  });

  it("affiche le libellé NON destructif du désabonnement", async () => {
    stubApi(mockedFetch, {});
    renderWithApp(
      <SidebarDialogsHarness
        initialDialog={{ kind: "unsubscribeFeed", feed }}
      />,
    );
    expect(
      await screen.findByText(/sauvegardés sont conservés/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Se désabonner" }),
    ).toBeInTheDocument();
  });

  it("affiche le libellé destructif de la suppression d'un feed", async () => {
    stubApi(mockedFetch, {});
    renderWithApp(
      <SidebarDialogsHarness initialDialog={{ kind: "deleteFeed", feed }} />,
    );
    expect(
      await screen.findByText(/Cette action est irréversible/i),
    ).toBeInTheDocument();
  });

  it("renomme un feed (PATCH /feeds/:id) depuis le dialogue renameFeed", async () => {
    let received: unknown;
    stubApi(mockedFetch, {
      "PATCH /feeds/:id": ({ body }: ApiHandlerContext) => {
        received = body;
        return { id: "f1", title: "Renommé", folderId: null };
      },
    });
    const { user } = renderWithApp(
      <SidebarDialogsHarness initialDialog={{ kind: "renameFeed", feed }} />,
    );

    const input = await screen.findByLabelText("Nom du flux");
    await user.clear(input);
    await user.type(input, "Renommé");
    await user.click(screen.getByRole("button", { name: "Renommer" }));

    await waitFor(() => expect(received).toEqual({ title: "Renommé" }));
  });

  it("supprime un dossier (DELETE /folders/:id) après confirmation", async () => {
    let called = false;
    stubApi(mockedFetch, {
      "DELETE /folders/:id": () => {
        called = true;
        return { ok: true };
      },
    });
    const { user } = renderWithApp(
      <SidebarDialogsHarness
        initialDialog={{ kind: "deleteFolder", folder }}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Supprimer" }));
    await waitFor(() => expect(called).toBe(true));
  });
});
