import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../lib/api";
import type { Settings } from "../lib/settings";
import { useServerThemeSync } from "../lib/use-theme";
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

function renderWithClient(ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  render(ui, { wrapper });
  return userEvent.setup();
}

function renderView() {
  return renderWithClient(<SettingsView />);
}

/** Harnais minimal pour `useServerThemeSync` (utilisé par le shell). */
function ThemeSyncHarness() {
  useServerThemeSync();
  return null;
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
    const user = renderView();

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
    const user = renderView();
    await screen.findByLabelText("Intervalle de rafraîchissement");

    await user.click(screen.getByRole("button", { name: "Sombre" }));
    await waitFor(() =>
      expect(mockedFetch).toHaveBeenCalledWith("/settings", {
        method: "PATCH",
        body: JSON.stringify({ theme: "dark" }),
      }),
    );
  });

  it("réconcilie le thème serveur→local au chargement (via le shell)", async () => {
    stubApi({ ...DEFAULTS, theme: "dark" });
    renderWithClient(<ThemeSyncHarness />);

    await waitFor(() =>
      expect(document.documentElement.dataset.theme).toBe("dark"),
    );
    expect(localStorage.getItem("boreas.theme")).toBe("dark");
  });
});
