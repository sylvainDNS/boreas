import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResetReplicaButton } from "./ResetReplicaButton";

const { wipeReplica, syncReplica } = vi.hoisted(() => ({
  wipeReplica: vi.fn(),
  syncReplica: vi.fn(),
}));
const { invalidateOfflineViews } = vi.hoisted(() => ({
  invalidateOfflineViews: vi.fn(),
}));

vi.mock("../lib/sync/replica", () => ({ wipeReplica, syncReplica }));
vi.mock("../lib/sync/use-replica-sync", () => ({ invalidateOfflineViews }));

/** Pose `navigator.onLine` (jsdom le laisse configurable). */
function setOnline(value: boolean) {
  Object.defineProperty(navigator, "onLine", { value, configurable: true });
}

function renderButton() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  render(<ResetReplicaButton />, { wrapper });
  return userEvent.setup();
}

beforeEach(() => {
  setOnline(true);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  setOnline(true);
});

describe("ResetReplicaButton", () => {
  it("désactive le bouton hors-ligne", () => {
    setOnline(false);
    renderButton();
    expect(
      screen.getByRole("button", { name: "Forcer une resynchronisation" }),
    ).toBeDisabled();
    expect(screen.getByText(/Reconnectez-vous/)).toBeInTheDocument();
  });

  it("vide le réplica et resync après confirmation", async () => {
    const user = renderButton();

    await user.click(
      screen.getByRole("button", { name: "Forcer une resynchronisation" }),
    );
    // Le dialog de confirmation s'ouvre.
    expect(
      screen.getByRole("heading", { name: "Forcer une resynchronisation ?" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Confirmer" }));

    await waitFor(() => {
      expect(wipeReplica).toHaveBeenCalledTimes(1);
      expect(syncReplica).toHaveBeenCalledTimes(1);
      expect(invalidateOfflineViews).toHaveBeenCalledTimes(1);
    });
    // Dialog refermé en cas de succès.
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", {
          name: "Forcer une resynchronisation ?",
        }),
      ).not.toBeInTheDocument(),
    );
  });

  it("affiche une erreur et garde le dialog ouvert si le vidage échoue", async () => {
    wipeReplica.mockRejectedValueOnce(new Error("boom"));
    const user = renderButton();

    await user.click(
      screen.getByRole("button", { name: "Forcer une resynchronisation" }),
    );
    await user.click(screen.getByRole("button", { name: "Confirmer" }));

    expect(
      await screen.findByText("Réinitialisation impossible, réessayez."),
    ).toBeInTheDocument();
    expect(syncReplica).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", { name: "Forcer une resynchronisation ?" }),
    ).toBeInTheDocument();
  });
});
