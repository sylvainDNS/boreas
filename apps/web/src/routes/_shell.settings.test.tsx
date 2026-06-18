import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../lib/api";
import type { Settings } from "../lib/settings";
import { renderWithApp } from "../test/render";
import { SettingsView } from "./_shell.settings";

vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedFetch = vi.mocked(apiFetch);

const DEFAULTS: Settings = {
  refreshIntervalMin: 30,
  purgeWindowDays: 60,
  theme: "system",
};

/** GET renvoie `get` ; tout PATCH renvoie le corps fusionné. */
function stubApi(get: Settings = DEFAULTS) {
  mockedFetch.mockImplementation(((_path: string, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      const patch = JSON.parse(init.body as string) as Partial<Settings>;
      return Promise.resolve({ ...get, ...patch });
    }
    return Promise.resolve(get);
  }) as never);
}

/**
 * Rendu sous routeur réel (`renderWithApp`) : la `SettingsView` héberge
 * désormais `LogoutButton`, qui consomme `useNavigate` — un mock de
 * `@tanstack/react-router` ne suffirait pas.
 */
function renderView() {
  return renderWithApp(<SettingsView />);
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  mockedFetch.mockReset();
});

describe("SettingsView (#18)", () => {
  it("affiche les valeurs chargées depuis GET /settings", async () => {
    stubApi();
    renderView();

    const refresh = await screen.findByLabelText<HTMLSelectElement>(
      "Intervalle de rafraîchissement",
    );
    await waitFor(() => expect(refresh.value).toBe("30"));
    const purge = screen.getByLabelText<HTMLSelectElement>("Fenêtre de purge");
    expect(purge.value).toBe("60");
    expect(mockedFetch).toHaveBeenCalledWith("/settings");
  });

  it("PATCH l'intervalle au changement de preset", async () => {
    stubApi();
    const { user } = renderView();

    const refresh = await screen.findByLabelText<HTMLSelectElement>(
      "Intervalle de rafraîchissement",
    );
    await waitFor(() => expect(refresh.value).toBe("30"));

    await user.selectOptions(refresh, "60");
    await waitFor(() =>
      expect(mockedFetch).toHaveBeenCalledWith("/settings", {
        method: "PATCH",
        body: JSON.stringify({ refreshIntervalMin: 60 }),
      }),
    );
  });

  it("PATCH le thème au choix dans le sélecteur segmenté", async () => {
    stubApi();
    const { user } = renderView();
    await screen.findByLabelText("Intervalle de rafraîchissement");

    await user.click(screen.getByRole("button", { name: "Sombre" }));
    await waitFor(() =>
      expect(mockedFetch).toHaveBeenCalledWith("/settings", {
        method: "PATCH",
        body: JSON.stringify({ theme: "dark" }),
      }),
    );
  });

  it("expose l'action « Se déconnecter » (#116)", async () => {
    stubApi();
    renderView();

    expect(
      await screen.findByRole("button", { name: "Se déconnecter" }),
    ).toBeInTheDocument();
  });
});
