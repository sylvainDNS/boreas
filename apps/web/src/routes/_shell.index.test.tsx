import "fake-indexeddb/auto";
import type { SyncArticle } from "@boreas/api-contracts";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../lib/api";
import { resetReplicaSingleton } from "../lib/sync/replica";
import {
  applyDelta,
  clearReplica,
  deleteReplica,
  openReplica,
} from "../lib/sync/replica-store";
import { renderWithApp } from "../test/render";
import { UnreadView } from "./_shell.index";

// `vi.mock` dans le fichier de test (hoisting Vitest, convention du repo).
vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedFetch = vi.mocked(apiFetch);

function art(over: Partial<SyncArticle> & { id: string }): SyncArticle {
  return {
    id: over.id,
    feedId: over.feedId ?? "feed-1",
    feedName: over.feedName ?? "Mon flux",
    title: over.title ?? `Titre ${over.id}`,
    summary: over.summary ?? "résumé",
    link: over.link ?? null,
    publishedAt: over.publishedAt ?? "2026-06-01T00:00:00Z",
    fetchedAt: over.fetchedAt ?? "2026-06-01T00:00:00Z",
    read: over.read ?? false,
    saved: over.saved ?? false,
  };
}

/** Pré-remplit le réplica (1er chargement en ligne déjà fait) puis le rebranche. */
async function seedReplica(articles: SyncArticle[]) {
  const db = await openReplica();
  await applyDelta(db, {
    upserts: { articles, feeds: [], folders: [] },
    tombstones: [],
  });
  db.close();
}

beforeEach(async () => {
  // Démonte tout composant résiduel (et ses effets de sync) AVANT de toucher au
  // réplica, sinon une connexion ouverte bloquerait la suppression de la base.
  cleanup();
  resetReplicaSingleton();
  // Vide les stores via une connexion neuve (robuste au `onblocked` d'un
  // `deleteDatabase` quand une autre connexion traîne encore).
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

describe("Vue « Tous les non-lus » — lecture du réplica local (#72)", () => {
  it("s'affiche hors-ligne (apiFetch en échec) en lisant le réplica", async () => {
    // Réplica pré-rempli par un précédent chargement en ligne.
    await seedReplica([
      art({ id: "a1", title: "Le vent du nord", read: false }),
      art({ id: "a2", title: "Article déjà lu", read: true }),
    ]);
    // Hors-ligne : tout appel réseau échoue (sync ET liste API du filtre `all`).
    mockedFetch.mockRejectedValue(new Error("offline"));

    const { user } = renderWithApp(<UnreadView />);

    // Bascule sur le filtre non-lus (local) : le switch part de showRead=true.
    // Le filtre par défaut `all` tente l'API et échoue ; en non-lus on lit local.
    const toggle = await screen.findByRole("switch");
    await user.click(toggle);

    // L'article non-lu du réplica s'affiche malgré le réseau coupé.
    await waitFor(() => {
      expect(screen.getByText("Le vent du nord")).toBeInTheDocument();
    });
    // L'article lu n'apparaît pas dans la river non-lus.
    expect(screen.queryByText("Article déjà lu")).not.toBeInTheDocument();
  });

  it("fait apparaître les nouveaux articles serveur après une sync (reconnexion)", async () => {
    // Réplica initial : un seul article.
    await seedReplica([art({ id: "a1", title: "Premier", read: false })]);

    // La sync renvoie un nouvel article net-new ; les autres routes (filtre all)
    // restent muettes (on ne les exerce pas ici).
    mockedFetch.mockImplementation(async (path: string) => {
      if (path.startsWith("/sync")) {
        return {
          upserts: {
            articles: [
              {
                ...art({ id: "a2", title: "Net-new après sync", read: false }),
              },
            ],
            feeds: [],
            folders: [],
          },
          tombstones: [],
          cursor: 1000,
          complete: true,
          stale: false,
        };
      }
      // Filtre `all` (défaut) : page vide pour ne pas polluer l'assertion.
      return { articles: [], nextCursor: null };
    });

    const { user } = renderWithApp(<UnreadView />);

    // On bascule sur la river non-lus (local) : l'article déjà répliqué s'affiche.
    const toggle = await screen.findByRole("switch");
    await user.click(toggle);
    await waitFor(() => {
      expect(screen.getByText("Premier")).toBeInTheDocument();
    });

    // Reconnexion : l'event `online` redéclenche une sync (useReplicaSync) qui
    // rapatrie le net-new, puis invalide la query non-lus montée → la vue relit
    // le réplica et le nouvel article apparaît.
    window.dispatchEvent(new Event("online"));

    await waitFor(() => {
      expect(screen.getByText("Net-new après sync")).toBeInTheDocument();
    });
    expect(screen.getByText("Premier")).toBeInTheDocument();
  });
});
