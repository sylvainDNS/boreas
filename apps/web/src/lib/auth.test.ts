import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRememberedSession,
  fetchSessionState,
  hasRememberedSession,
  logout,
  rememberSession,
  SESSION_REMEMBERED_KEY,
} from "./auth";

/**
 * Tests de la logique d'auth adaptative (#76, ADR 0018 « Boot & auth
 * hors-ligne »). On exerce ici le `queryFn` (`fetchSessionState`) et la
 * mémorisation locale, indépendamment du guard de route.
 */

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mémorisation locale de la session", () => {
  it("rememberSession pose le flag, hasRememberedSession le lit", () => {
    expect(hasRememberedSession()).toBe(false);
    rememberSession();
    expect(localStorage.getItem(SESSION_REMEMBERED_KEY)).toBe("1");
    expect(hasRememberedSession()).toBe(true);
  });

  it("clearRememberedSession efface le flag", () => {
    rememberSession();
    clearRememberedSession();
    expect(localStorage.getItem(SESSION_REMEMBERED_KEY)).toBeNull();
    expect(hasRememberedSession()).toBe(false);
  });

  it("ne lève pas si localStorage est indisponible", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage indisponible");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage indisponible");
    });
    expect(() => rememberSession()).not.toThrow();
    expect(hasRememberedSession()).toBe(false);
  });
});

describe("fetchSessionState — en ligne", () => {
  it("200 → authentifié et mémorise la session", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    await expect(fetchSessionState()).resolves.toBe(true);
    expect(hasRememberedSession()).toBe(true);
  });

  it("401 réel → non authentifié et efface la session mémorisée", async () => {
    rememberSession();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 401 }),
    );
    await expect(fetchSessionState()).resolves.toBe(false);
    // Un 401 en ligne est une déconnexion : le flag local est purgé.
    expect(hasRememberedSession()).toBe(false);
  });
});

describe("fetchSessionState — hors-ligne (erreur réseau)", () => {
  it("erreur réseau + session mémorisée → boot autorisé (true)", async () => {
    rememberSession();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("Failed to fetch"),
    );
    // Hors-ligne : on fait confiance à la session réussie antérieure.
    await expect(fetchSessionState()).resolves.toBe(true);
    // Le flag est conservé : ce n'est pas une déconnexion.
    expect(hasRememberedSession()).toBe(true);
  });

  it("erreur réseau sans session mémorisée → non authentifié (false)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("Failed to fetch"),
    );
    await expect(fetchSessionState()).resolves.toBe(false);
  });
});

describe("fetchSessionState — erreur serveur (5xx, ni 200 ni 401)", () => {
  it("5xx + session mémorisée → dégradation gracieuse, boot autorisé (true) sans effacer le flag", async () => {
    rememberSession();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 503 }),
    );
    // Incident serveur transitoire : on ne déconnecte pas (≠ 401), on retombe
    // sur la session mémorisée comme en hors-ligne.
    await expect(fetchSessionState()).resolves.toBe(true);
    expect(hasRememberedSession()).toBe(true);
  });

  it("5xx sans session mémorisée → non authentifié (false)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 500 }),
    );
    await expect(fetchSessionState()).resolves.toBe(false);
  });
});

describe("logout", () => {
  it("efface le flag même si la requête réseau échoue (logout hors-ligne)", async () => {
    rememberSession();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("Failed to fetch"),
    );
    // Logout best-effort : ne doit pas rejeter, et doit oublier la session pour
    // empêcher un boot offline « fantôme » après déconnexion volontaire.
    await expect(logout()).resolves.toBeUndefined();
    expect(hasRememberedSession()).toBe(false);
  });
});
