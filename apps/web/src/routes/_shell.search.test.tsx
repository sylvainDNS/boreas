import "fake-indexeddb/auto";
import type { SyncArticle, SyncFeed } from "@boreas/api-contracts";
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
import { SearchView } from "./_shell.search";

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
    summary: over.summary ?? null,
    link: over.link ?? null,
    publishedAt: over.publishedAt ?? "2026-06-01T00:00:00Z",
    fetchedAt: over.fetchedAt ?? "2026-06-01T00:00:00Z",
    read: over.read ?? false,
    saved: over.saved ?? false,
  };
}

function feed(over: Partial<SyncFeed> & { id: string }): SyncFeed {
  return {
    id: over.id,
    url: `https://src.example/${over.id}.xml`,
    title: `Flux ${over.id}`,
    status: "ok",
    lastError: null,
    lastCheckAt: null,
    folderId: null,
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

beforeEach(async () => {
  cleanup();
  resetReplicaSingleton();
  const db = await openReplica();
  await clearReplica(db);
  db.close();
  await deleteReplica();
  resetReplicaSingleton();
  // Hors-ligne total : la recherche doit fonctionner sans réseau (AC#3).
  mockedFetch.mockRejectedValue(new Error("offline"));
});

afterEach(() => {
  cleanup();
  mockedFetch.mockReset();
  resetReplicaSingleton();
});

describe("Vue recherche — hors-ligne sur le réplica (#73)", () => {
  it("affiche les résultats correspondant à ?q, hors-ligne", async () => {
    await seedReplica(
      [
        art({ id: "a1", title: "Le vent du nord" }),
        art({ id: "a2", title: "Sujet sans rapport" }),
      ],
      [feed({ id: "feed-1" })],
    );

    renderWithApp(<SearchView />, { initialPath: "/search?q=vent" });

    await waitFor(() => {
      expect(screen.getByText("Le vent du nord")).toBeInTheDocument();
    });
    expect(screen.queryByText("Sujet sans rapport")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Recherche : « vent »" }),
    ).toBeInTheDocument();
  });
});
