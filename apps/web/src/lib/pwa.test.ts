import { afterEach, describe, expect, it, vi } from "vitest";
import { requestPersistentStorage } from "./pwa";

/**
 * Tests du helper `storage.persist()` (#76, ADR 0018). Best-effort : ne lève
 * jamais, no-op si l'API est absente (jsdom, navigateurs anciens).
 */

afterEach(() => {
  vi.restoreAllMocks();
  // Restaure un éventuel `navigator.storage` injecté pour le test.
  Object.defineProperty(navigator, "storage", {
    value: undefined,
    configurable: true,
  });
});

describe("requestPersistentStorage", () => {
  it("ne lève pas et renvoie false quand l'API storage est absente", async () => {
    Object.defineProperty(navigator, "storage", {
      value: undefined,
      configurable: true,
    });
    await expect(requestPersistentStorage()).resolves.toBe(false);
  });

  it("ne redemande pas la persistance si déjà accordée", async () => {
    const persist = vi.fn();
    Object.defineProperty(navigator, "storage", {
      value: { persisted: vi.fn().mockResolvedValue(true), persist },
      configurable: true,
    });
    await expect(requestPersistentStorage()).resolves.toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });

  it("demande la persistance quand elle n'est pas encore accordée", async () => {
    const persist = vi.fn().mockResolvedValue(true);
    Object.defineProperty(navigator, "storage", {
      value: { persisted: vi.fn().mockResolvedValue(false), persist },
      configurable: true,
    });
    await expect(requestPersistentStorage()).resolves.toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("avale une erreur de l'API et renvoie false", async () => {
    Object.defineProperty(navigator, "storage", {
      value: {
        persisted: vi.fn().mockRejectedValue(new Error("indisponible")),
        persist: vi.fn(),
      },
      configurable: true,
    });
    await expect(requestPersistentStorage()).resolves.toBe(false);
  });
});
