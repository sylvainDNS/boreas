import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "./api";
import type { Settings } from "./settings";
import {
  getStoredPreference,
  initTheme,
  setPreference,
  subscribePreference,
  useServerThemeSync,
  useTheme,
} from "./theme";

vi.mock("./api", async (importActual) => {
  const actual = await importActual<typeof import("./api")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedFetch = vi.mocked(apiFetch);

const DEFAULTS: Settings = {
  refreshIntervalMin: 30,
  purgeWindowDays: 60,
  theme: "system",
};

/** GET renvoie `get` ; tout PATCH renvoie le corps fusionné. */
function stubSettings(get: Settings = DEFAULTS) {
  mockedFetch.mockImplementation(((_path: string, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      const patch = JSON.parse(init.body as string) as Partial<Settings>;
      return Promise.resolve({ ...get, ...patch });
    }
    return Promise.resolve(get);
  }) as never);
}

/**
 * Mock minimal de `matchMedia` (absent de jsdom). Permet de piloter
 * `prefers-color-scheme: dark` et de déclencher l'écouteur de changement système.
 */
function stubMatchMedia(dark: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mql = {
    matches: dark,
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) =>
      listeners.add(cb),
    removeEventListener: (
      _type: string,
      cb: (e: MediaQueryListEvent) => void,
    ) => listeners.delete(cb),
  };
  window.matchMedia = vi.fn().mockReturnValue(mql) as never;
  return {
    /** Bascule la préférence système et notifie les écouteurs. */
    set(next: boolean) {
      mql.matches = next;
      for (const cb of listeners) cb({ matches: next } as MediaQueryListEvent);
    },
  };
}

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function testClient() {
  return new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  stubMatchMedia(false);
});

afterEach(() => {
  mockedFetch.mockReset();
});

describe("setPreference", () => {
  it("pose data-theme, persiste en localStorage et notifie les abonnés", () => {
    const onChange = vi.fn();
    const unsubscribe = subscribePreference(onChange);

    setPreference("dark");

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("boreas.theme")).toBe("dark");
    expect(getStoredPreference()).toBe("dark");
    expect(onChange).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it("résout 'system' via prefers-color-scheme", () => {
    stubMatchMedia(true);
    setPreference("system");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("retombe sur 'system' sans crash si localStorage lève", () => {
    const getItem = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("storage indisponible");
      });
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("storage indisponible");
      });

    expect(() => setPreference("dark")).not.toThrow();
    // L'écriture a levé : le thème s'applique pour la session mais n'est pas lu.
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(getStoredPreference()).toBe("system");

    getItem.mockRestore();
    setItem.mockRestore();
  });
});

describe("initTheme", () => {
  it("suit prefers-color-scheme tant que la préférence est 'system'", () => {
    const media = stubMatchMedia(false);
    const cleanup = initTheme();

    // Préférence "system" (défaut) → suit le système.
    expect(document.documentElement.dataset.theme).toBe("light");
    media.set(true);
    expect(document.documentElement.dataset.theme).toBe("dark");

    cleanup();
  });

  it("ignore les changements système quand une préférence explicite est posée", () => {
    const media = stubMatchMedia(false);
    setPreference("light");
    const cleanup = initTheme();

    media.set(true);
    // Préférence explicite "light" → le changement système est ignoré.
    expect(document.documentElement.dataset.theme).toBe("light");

    cleanup();
  });
});

describe("useTheme", () => {
  it("applique localement avant le PATCH serveur", async () => {
    stubSettings();
    const client = testClient();
    const { result } = renderHook(() => useTheme(), {
      wrapper: wrapper(client),
    });

    result.current.setPreference("dark");

    // Application locale synchrone, avant tout aller-retour réseau.
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("boreas.theme")).toBe("dark");

    await waitFor(() =>
      expect(mockedFetch).toHaveBeenCalledWith("/settings", {
        method: "PATCH",
        body: JSON.stringify({ theme: "dark" }),
      }),
    );
    await waitFor(() => expect(result.current.preference).toBe("dark"));
  });

  it("n'altère pas le thème local si le PATCH échoue", async () => {
    mockedFetch.mockRejectedValue(new Error("réseau indisponible"));
    const client = testClient();
    const { result } = renderHook(() => useTheme(), {
      wrapper: wrapper(client),
    });

    result.current.setPreference("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");

    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());
    // Le PATCH a échoué (fire-and-forget) : le thème local reste appliqué.
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(getStoredPreference()).toBe("dark");
  });
});

describe("useServerThemeSync", () => {
  it("réconcilie serveur→local au chargement (#18)", async () => {
    stubSettings({ ...DEFAULTS, theme: "dark" });
    const client = testClient();
    renderHook(() => useServerThemeSync(), { wrapper: wrapper(client) });

    await waitFor(() =>
      expect(document.documentElement.dataset.theme).toBe("dark"),
    );
    expect(localStorage.getItem("boreas.theme")).toBe("dark");
  });

  it("no-op si le thème serveur égale la préférence locale", async () => {
    setPreference("dark");
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    stubSettings({ ...DEFAULTS, theme: "dark" });
    const client = testClient();
    renderHook(() => useServerThemeSync(), { wrapper: wrapper(client) });

    await waitFor(() => expect(mockedFetch).toHaveBeenCalledWith("/settings"));
    // Égaux : aucune réécriture de la préférence.
    expect(setItemSpy).not.toHaveBeenCalled();

    setItemSpy.mockRestore();
  });
});
