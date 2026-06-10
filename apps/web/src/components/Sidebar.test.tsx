import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../lib/api";
import type { Feed } from "../lib/feeds";
import type { Folder } from "../lib/folders";
import type { ApiHandlerContext } from "../test/api-mock";
import { stubApi } from "../test/api-mock";
import { renderWithApp } from "../test/render";
import { Sidebar } from "./Sidebar";

vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedFetch = vi.mocked(apiFetch);

afterEach(() => {
  mockedFetch.mockReset();
});

function makeFeed(id: string, folderId: string | null = null): Feed {
  return {
    id,
    url: `https://example.com/${id}`,
    title: id,
    status: "ok",
    lastError: null,
    lastCheckAt: null,
    folderId,
  };
}

const emptyCounts = { total: 0, byFeed: [], byFolder: [] };

describe("Sidebar (intégration)", () => {
  it("affiche les feeds, les folders et le compteur global", async () => {
    const feeds: Feed[] = [makeFeed("alpha"), makeFeed("beta", "tech")];
    const folders: Folder[] = [{ id: "tech", name: "Tech" }];
    stubApi(mockedFetch, {
      "GET /articles/counts": {
        total: 5,
        byFeed: [{ feedId: "alpha", count: 2 }],
        byFolder: [{ folderId: "tech", count: 3 }],
      },
      "GET /feeds": { feeds },
      "GET /folders": { folders },
    });

    renderWithApp(<Sidebar />);

    expect(await screen.findByText("Tech")).toBeInTheDocument();
    expect(
      await screen.findByRole("link", { name: /alpha/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
  });

  it("crée un dossier de bout en bout (menu + → dialogue → POST)", async () => {
    let createdName: string | undefined;
    stubApi(mockedFetch, {
      "GET /articles/counts": emptyCounts,
      "GET /feeds": { feeds: [] },
      "GET /folders": { folders: [] },
      "POST /folders": ({ body }: ApiHandlerContext) => {
        createdName = (body as { name: string }).name;
        return { id: "new", name: createdName };
      },
    });

    const { user } = renderWithApp(<Sidebar />);

    await user.click(
      await screen.findByRole("button", { name: "Nouveau dossier" }),
    );
    await user.type(await screen.findByLabelText("Nom du dossier"), "Sport");
    await user.click(screen.getByRole("button", { name: "Créer" }));

    await waitFor(() => expect(createdName).toBe("Sport"));
  });

  it("désabonne un feed après confirmation et navigue hors du feed actif", async () => {
    let unsubscribed: string | undefined;
    stubApi(mockedFetch, {
      "GET /articles/counts": emptyCounts,
      "GET /feeds": { feeds: [makeFeed("alpha")] },
      "GET /folders": { folders: [] },
      "POST /feeds/:id/unsubscribe": ({ params }: ApiHandlerContext) => {
        unsubscribed = params.id;
        return { status: "unsubscribed" };
      },
    });

    const { user, router } = renderWithApp(<Sidebar />, {
      initialPath: "/feeds/alpha",
    });

    await user.click(
      await screen.findByRole("button", { name: /Actions pour alpha/ }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Se désabonner" }));
    await user.click(screen.getByRole("button", { name: "Se désabonner" }));

    await waitFor(() => expect(unsubscribed).toBe("alpha"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("affiche l'erreur quand la création de dossier échoue", async () => {
    stubApi(mockedFetch, {
      "GET /articles/counts": emptyCounts,
      "GET /feeds": { feeds: [] },
      "GET /folders": { folders: [] },
      "POST /folders": () => {
        throw new Error("boom");
      },
    });

    const { user } = renderWithApp(<Sidebar />);

    await user.click(
      await screen.findByRole("button", { name: "Nouveau dossier" }),
    );
    await user.type(await screen.findByLabelText("Nom du dossier"), "Sport");
    await user.click(screen.getByRole("button", { name: "Créer" }));

    expect(
      await screen.findByText("Création impossible, réessayez."),
    ).toBeInTheDocument();
  });
});
