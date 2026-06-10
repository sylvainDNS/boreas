import { useQuery } from "@tanstack/react-query";
import { Link, useMatchRoute, useNavigate } from "@tanstack/react-router";
import { renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../lib/api";
import { stubApi } from "./api-mock";
import {
  createAppWrapper,
  createTestQueryClient,
  renderWithApp,
} from "./render";

// `vi.mock` reste dans le fichier de test (hoisting Vitest, convention du repo).
vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedFetch = vi.mocked(apiFetch);

afterEach(() => {
  mockedFetch.mockReset();
});

/**
 * Composant de démonstration : exerce les trois primitives de routeur
 * (`Link`, `useNavigate`, `useMatchRoute`) et un `useQuery` réel alimenté par la
 * table de routes mockée. C'est le contrat minimal que la harness doit garantir
 * pour débloquer les tests de Sidebar/routes (#47–#49).
 */
function NavDemo() {
  const navigate = useNavigate();
  const matchRoute = useMatchRoute();
  const onIndex = matchRoute({ to: "/" });
  const settings = useQuery({
    queryKey: ["demo", "settings"],
    queryFn: () => apiFetch<{ theme: string }>("/settings"),
  });

  return (
    <div>
      <p>{onIndex ? "sur l'accueil" : "ailleurs"}</p>
      {settings.data && <p>thème : {settings.data.theme}</p>}
      <Link to="/saved">Vers Saved</Link>
      <button type="button" onClick={() => navigate({ to: "/settings" })}>
        Aller aux réglages
      </button>
    </div>
  );
}

describe("harness de tests d'intégration SPA", () => {
  it("monte un composant où Link, useNavigate et useMatchRoute fonctionnent", async () => {
    stubApi(mockedFetch, { "GET /settings": { theme: "dark" } });
    const { user, router } = renderWithApp(<NavDemo />);

    // useMatchRoute : on démarre bien sur l'index.
    expect(await screen.findByText("sur l'accueil")).toBeInTheDocument();
    // useQuery réel + apiFetch mocké par table de routes.
    expect(await screen.findByText("thème : dark")).toBeInTheDocument();

    // Link : navigation déclarative vers /saved.
    await user.click(screen.getByRole("link", { name: "Vers Saved" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/saved"));

    // useNavigate : navigation impérative vers /settings.
    await user.click(
      screen.getByRole("button", { name: "Aller aux réglages" }),
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/settings"),
    );
  });

  it("démarre sur initialPath et rejette une route non mockée", async () => {
    // Aucune route mockée : l'appel /settings doit être rejeté explicitement.
    stubApi(mockedFetch, {});
    const client = createTestQueryClient();
    const { router } = renderWithApp(<NavDemo />, {
      initialPath: "/saved",
      client,
    });

    expect(router.state.location.pathname).toBe("/saved");
    await screen.findByText("ailleurs");
    await waitFor(() =>
      expect(client.getQueryState(["demo", "settings"])?.status).toBe("error"),
    );
  });

  it("createAppWrapper alimente renderHook (useQuery + apiFetch mocké)", async () => {
    stubApi(mockedFetch, { "GET /settings": { theme: "light" } });
    const { result } = renderHook(
      () =>
        useQuery({
          queryKey: ["demo", "settings"],
          queryFn: () => apiFetch<{ theme: string }>("/settings"),
        }),
      { wrapper: createAppWrapper() },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ theme: "light" });
  });
});
