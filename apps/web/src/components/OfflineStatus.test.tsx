import "fake-indexeddb/auto";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enqueueOutbox } from "../lib/sync/outbox-store";
import { resetReplicaSingleton } from "../lib/sync/replica";
import { deleteReplica, openReplica } from "../lib/sync/replica-store";
import { renderWithApp } from "../test/render";
import { OfflineStatus } from "./OfflineStatus";

/** Pose `navigator.onLine` (jsdom le laisse configurable). */
function setOnline(value: boolean) {
  Object.defineProperty(navigator, "onLine", {
    value,
    configurable: true,
  });
}

beforeEach(async () => {
  cleanup();
  resetReplicaSingleton();
  await deleteReplica();
  resetReplicaSingleton();
  setOnline(true);
});

afterEach(() => {
  cleanup();
  resetReplicaSingleton();
  setOnline(true);
});

describe("OfflineStatus (#81)", () => {
  it("n'affiche rien quand on est en ligne sans action en attente", async () => {
    renderWithApp(<OfflineStatus />);
    // Laisse la query d'outbox se résoudre (0 entrée) sans rien afficher.
    await waitFor(() => {
      expect(screen.queryByText(/Hors-ligne/)).not.toBeInTheDocument();
      expect(screen.queryByText(/en attente/)).not.toBeInTheDocument();
    });
  });

  it("affiche l'indicateur hors-ligne quand navigator.onLine est false", async () => {
    setOnline(false);
    renderWithApp(<OfflineStatus />);
    expect(await screen.findByText(/Hors-ligne/)).toBeInTheDocument();
  });

  it("affiche le badge « N actions en attente » selon l'outbox", async () => {
    const db = await openReplica();
    await enqueueOutbox(db, {
      kind: "patch",
      articleId: "a1",
      field: "read",
      value: true,
    });
    await enqueueOutbox(db, {
      kind: "patch",
      articleId: "a2",
      field: "saved",
      value: true,
    });
    db.close();

    renderWithApp(<OfflineStatus />);
    expect(await screen.findByText(/2 actions en attente/)).toBeInTheDocument();
  });

  it("réagit à l'event offline du navigateur", async () => {
    renderWithApp(<OfflineStatus />);
    await waitFor(() =>
      expect(screen.queryByText(/Hors-ligne/)).not.toBeInTheDocument(),
    );

    act(() => {
      setOnline(false);
      window.dispatchEvent(new Event("offline"));
    });

    expect(await screen.findByText(/Hors-ligne/)).toBeInTheDocument();
  });
});
