import "fake-indexeddb/auto";
import type { SyncArticle, SyncFeed } from "@boreas/api-contracts";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../lib/api";
import type { Feed } from "../lib/feeds";
import type { Folder } from "../lib/folders";
import { resetReplicaSingleton } from "../lib/sync/replica";
import {
  applyDelta,
  clearReplica,
  deleteReplica,
  openReplica,
} from "../lib/sync/replica-store";
import type { ApiHandlerContext } from "../test/api-mock";
import { stubApi } from "../test/api-mock";
import { renderWithApp } from "../test/render";
import { Sidebar } from "./Sidebar";

vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedFetch = vi.mocked(apiFetch);

beforeEach(async () => {
  // Réplica vierge : les compteurs de la sidebar sont calculés localement (#73).
  cleanup();
  resetReplicaSingleton();
  const db = await openReplica();
  await clearReplica(db);
  db.close();
  await deleteReplica();
  resetReplicaSingleton();
});

afterEach(() => {
  cleanup();
  mockedFetch.mockReset();
  resetReplicaSingleton();
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

/** Article répliqué (non-lu par défaut) pour alimenter les compteurs locaux. */
function art(over: Partial<SyncArticle> & { id: string }): SyncArticle {
  return {
    id: over.id,
    feedId: over.feedId ?? "feed-1",
    feedName: "Flux",
    title: over.title ?? `Titre ${over.id}`,
    summary: null,
    link: null,
    publishedAt: "2026-06-01T00:00:00Z",
    fetchedAt: "2026-06-01T00:00:00Z",
    read: over.read ?? false,
    saved: over.saved ?? false,
  };
}

/** Feed répliqué (porte `folderId`/`unsubscribed`, lus par les compteurs locaux). */
function syncFeed(over: Partial<SyncFeed> & { id: string }): SyncFeed {
  return {
    id: over.id,
    url: `https://example.com/${over.id}`,
    title: over.id,
    status: "ok",
    lastError: null,
    lastCheckAt: null,
    folderId: over.folderId ?? null,
    unsubscribed: over.unsubscribed ?? false,
  };
}

async function seedReplica(articles: SyncArticle[], feeds: SyncFeed[] = []) {
  const db = await openReplica();
  await applyDelta(db, {
    upserts: { articles, feeds, folders: [] },
    tombstones: [],
  });
  db.close();
}

describe("Sidebar (intégration)", () => {
  it("affiche les feeds, les folders et le compteur global (compteurs locaux #73)", async () => {
    const feeds: Feed[] = [makeFeed("alpha"), makeFeed("beta", "tech")];
    const folders: Folder[] = [{ id: "tech", name: "Tech" }];
    // 5 non-lus au total, calculés localement depuis le réplica.
    await seedReplica(
      [
        art({ id: "u1", feedId: "alpha" }),
        art({ id: "u2", feedId: "alpha" }),
        art({ id: "u3", feedId: "beta" }),
        art({ id: "u4", feedId: "beta" }),
        art({ id: "u5", feedId: "beta" }),
      ],
      [syncFeed({ id: "alpha" }), syncFeed({ id: "beta", folderId: "tech" })],
    );
    stubApi(mockedFetch, {
      "GET /feeds": { feeds },
      "GET /folders": { folders },
    });

    renderWithApp(<Sidebar />);

    expect(await screen.findByText("Tech")).toBeInTheDocument();
    expect(
      await screen.findByRole("link", { name: /alpha/ }),
    ).toBeInTheDocument();
    expect(await screen.findByText("5")).toBeInTheDocument();
  });

  it("crée un dossier de bout en bout (menu + → dialogue → POST)", async () => {
    let createdName: string | undefined;
    stubApi(mockedFetch, {
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
