import { QueryClient } from "@tanstack/react-query";
import { isRedirect } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberSession, SESSION_REMEMBERED_KEY } from "../lib/auth";
import { Route } from "./_shell";

/** Assert qu'une valeur est un `redirect` TanStack Router vers `to`. */
async function expectRedirectTo(promise: Promise<void>, to: string) {
  await expect(promise).rejects.toSatisfy(
    (e: unknown) =>
      isRedirect(e) && (e as { options: { to: string } }).options.to === to,
  );
}

/**
 * Tests du **guard adaptatif** de `_shell` (#76, ADR 0018). On exerce
 * directement le `beforeLoad` de la route avec un `queryClient` réel : il doit
 * laisser passer quand la session est valide (ou offline-mémorisée) et lever un
 * `redirect` vers `/login` uniquement sur un `false` (401 réel / pas de session
 * mémorisée hors-ligne).
 */

type BeforeLoad = (args: {
  context: { queryClient: QueryClient };
}) => Promise<void>;

function runGuard(): Promise<void> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // `beforeLoad` n'a besoin que de `context.queryClient` dans notre guard.
  const beforeLoad = Route.options.beforeLoad as unknown as BeforeLoad;
  return beforeLoad({ context: { queryClient } });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("guard _shell adaptatif", () => {
  it("laisse passer (pas de redirect) sur 200 en ligne", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    await expect(runGuard()).resolves.toBeUndefined();
  });

  it("redirige vers /login sur 401 réel en ligne", async () => {
    rememberSession();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 401 }),
    );
    await expectRedirectTo(runGuard(), "/login");
    // Déconnexion : la session mémorisée est purgée.
    expect(localStorage.getItem(SESSION_REMEMBERED_KEY)).toBeNull();
  });

  it("laisse passer hors-ligne quand une session est mémorisée (pas de redirect)", async () => {
    rememberSession();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("Failed to fetch"),
    );
    // Erreur réseau + session mémorisée : boot autorisé, aucune redirection.
    await expect(runGuard()).resolves.toBeUndefined();
    // Le flag est conservé : une coupure réseau n'est pas une déconnexion.
    expect(localStorage.getItem(SESSION_REMEMBERED_KEY)).toBe("1");
  });

  it("redirige hors-ligne sans session mémorisée", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("Failed to fetch"),
    );
    await expectRedirectTo(runGuard(), "/login");
  });
});
