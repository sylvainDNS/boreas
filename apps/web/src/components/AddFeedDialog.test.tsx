import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch } from "../lib/api";
import { AddFeedDialog } from "./AddFeedDialog";

// On mocke le transport bas niveau (`apiFetch`) en conservant la vraie classe
// `ApiError` et toute la logique de `submitFeedUrl`/mutation au-dessus.
vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedFetch = vi.mocked(apiFetch);

function renderDialog(
  props: { folderId?: string | null; folderName?: string } = {},
  onClose = vi.fn(),
) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  render(<AddFeedDialog open onClose={onClose} {...props} />, { wrapper });
  return { onClose, user: userEvent.setup() };
}

afterEach(() => {
  mockedFetch.mockReset();
});

describe("AddFeedDialog", () => {
  it("abonne directement et ferme le dialog (kind: subscribed)", async () => {
    mockedFetch.mockResolvedValueOnce({
      feed: { id: "f1", url: "https://blog.example/feed.xml", title: "Blog" },
      articleCount: 3,
    });
    const { onClose, user } = renderDialog();

    await user.type(
      screen.getByLabelText(/URL du flux/i),
      "https://blog.example/feed.xml",
    );
    await user.click(screen.getByRole("button", { name: "Ajouter" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(mockedFetch).toHaveBeenCalledWith(
      "/feeds",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("affiche le sélecteur sur N candidats puis abonne le candidat choisi", async () => {
    // 1er appel : le site expose 2 flux. 2e appel (candidat choisi) : abonné.
    mockedFetch.mockResolvedValueOnce({
      candidates: [
        { url: "https://site.example/rss.xml", title: "RSS", type: "rss" },
        { url: "https://site.example/atom.xml", title: "Atom", type: "atom" },
      ],
    });
    mockedFetch.mockResolvedValueOnce({
      feed: { id: "f1", url: "https://site.example/atom.xml", title: "Atom" },
      articleCount: 1,
    });
    const { onClose, user } = renderDialog();

    await user.type(
      screen.getByLabelText(/URL du flux/i),
      "https://site.example",
    );
    await user.click(screen.getByRole("button", { name: "Ajouter" }));

    // Le sélecteur liste les deux candidats.
    expect(await screen.findByText("RSS")).toBeInTheDocument();
    expect(screen.getByText("Atom")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    // Choix du 2e candidat → ré-appel avec son URL → abonnement → fermeture.
    await user.click(screen.getByText("Atom"));

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(mockedFetch).toHaveBeenLastCalledWith(
      "/feeds",
      expect.objectContaining({
        body: JSON.stringify({ url: "https://site.example/atom.xml" }),
      }),
    );
  });

  it("affiche un message ciblé pour already_subscribed", async () => {
    mockedFetch.mockRejectedValueOnce(new ApiError(409, "already_subscribed"));
    const { onClose, user } = renderDialog();

    await user.type(
      screen.getByLabelText(/URL du flux/i),
      "https://blog.example/feed.xml",
    );
    await user.click(screen.getByRole("button", { name: "Ajouter" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/déjà abonné/i);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("pré-scopé : soumet avec le folderId fourni (#118)", async () => {
    mockedFetch.mockResolvedValueOnce({
      feed: { id: "f1", url: "https://blog.example/feed.xml", title: "Blog" },
      articleCount: 3,
    });
    const { user } = renderDialog({ folderId: "fo1", folderName: "Tech" });

    await user.type(
      screen.getByLabelText(/URL du flux/i),
      "https://blog.example/feed.xml",
    );
    await user.click(screen.getByRole("button", { name: "Ajouter" }));

    await waitFor(() =>
      expect(mockedFetch).toHaveBeenCalledWith(
        "/feeds",
        expect.objectContaining({
          body: JSON.stringify({
            url: "https://blog.example/feed.xml",
            folderId: "fo1",
          }),
        }),
      ),
    );
  });

  it("sans dossier : soumet sans folderId dans le corps (#118)", async () => {
    mockedFetch.mockResolvedValueOnce({
      feed: { id: "f1", url: "https://blog.example/feed.xml", title: "Blog" },
      articleCount: 3,
    });
    const { user } = renderDialog();

    await user.type(
      screen.getByLabelText(/URL du flux/i),
      "https://blog.example/feed.xml",
    );
    await user.click(screen.getByRole("button", { name: "Ajouter" }));

    await waitFor(() =>
      expect(mockedFetch).toHaveBeenCalledWith(
        "/feeds",
        expect.objectContaining({
          body: JSON.stringify({ url: "https://blog.example/feed.xml" }),
        }),
      ),
    );
  });

  it("le candidat choisi est aussi soumis avec le folderId (#118)", async () => {
    mockedFetch.mockResolvedValueOnce({
      candidates: [
        { url: "https://site.example/rss.xml", title: "RSS", type: "rss" },
      ],
    });
    mockedFetch.mockResolvedValueOnce({
      feed: { id: "f1", url: "https://site.example/rss.xml", title: "RSS" },
      articleCount: 1,
    });
    const { user } = renderDialog({ folderId: "fo1", folderName: "Tech" });

    await user.type(
      screen.getByLabelText(/URL du flux/i),
      "https://site.example",
    );
    await user.click(screen.getByRole("button", { name: "Ajouter" }));
    await user.click(await screen.findByText("RSS"));

    await waitFor(() =>
      expect(mockedFetch).toHaveBeenLastCalledWith(
        "/feeds",
        expect.objectContaining({
          body: JSON.stringify({
            url: "https://site.example/rss.xml",
            folderId: "fo1",
          }),
        }),
      ),
    );
  });

  it("titre contextuel quand folderName est fourni (#118)", () => {
    renderDialog({ folderId: "fo1", folderName: "Tech" });
    expect(
      screen.getByRole("heading", { name: "Ajouter un flux dans Tech" }),
    ).toBeInTheDocument();
  });

  it("titre générique sans folderName", () => {
    renderDialog();
    expect(
      screen.getByRole("heading", { name: "Ajouter un flux" }),
    ).toBeInTheDocument();
  });
});
