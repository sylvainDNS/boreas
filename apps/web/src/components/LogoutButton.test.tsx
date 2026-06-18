import { QueryClient } from "@tanstack/react-query";
import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_QUERY_KEY } from "../lib/auth";
import { renderWithApp } from "../test/render";
import { LogoutButton } from "./LogoutButton";

// On mocke uniquement `logout` (transport réseau best-effort) et on garde le
// reste de `../lib/auth` réel : `AUTH_QUERY_KEY` doit rester la vraie clé pour
// asserter la pose du cache de session.
const { logout } = vi.hoisted(() => ({ logout: vi.fn() }));

vi.mock("../lib/auth", async (importActual) => {
  const actual = await importActual<typeof import("../lib/auth")>();
  return { ...actual, logout };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("LogoutButton", () => {
  it("déconnecte : appelle logout, pose AUTH_QUERY_KEY=false et navigue vers /login", async () => {
    logout.mockResolvedValueOnce(undefined);
    // `gcTime: Infinity` : `AUTH_QUERY_KEY` n'a aucun observer ici, le défaut
    // `gcTime: 0` du client de test le collecterait avant l'assertion.
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
        mutations: { retry: false },
      },
    });
    const { user, router } = renderWithApp(<LogoutButton />, { client });

    await user.click(
      await screen.findByRole("button", { name: "Se déconnecter" }),
    );

    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(client.getQueryData(AUTH_QUERY_KEY)).toBe(false),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
  });

  it("désactive le bouton pendant la déconnexion en cours", async () => {
    // `logout` reste en attente : le bouton doit passer désactivé.
    let resolve: (() => void) | undefined;
    logout.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    const { user } = renderWithApp(<LogoutButton />);

    const button = await screen.findByRole("button", {
      name: "Se déconnecter",
    });
    await user.click(button);

    await waitFor(() => expect(button).toBeDisabled());
    resolve?.();
  });
});
