import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PERIODIC_SYNC_TAG,
  registerPeriodicSync,
  requestPersistentStorage,
} from "./pwa";

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

/**
 * Tests de `registerPeriodicSync` (#81, ADR 0018). Best-effort, jamais bloquant,
 * gardé par le support (`periodicSync` sur la registration) + la permission
 * (`granted`). On mocke `navigator.permissions` et une registration minimale.
 */
describe("registerPeriodicSync", () => {
  function setPermission(state: PermissionState | "absent") {
    if (state === "absent") {
      Object.defineProperty(navigator, "permissions", {
        value: undefined,
        configurable: true,
      });
      return;
    }
    Object.defineProperty(navigator, "permissions", {
      value: { query: vi.fn().mockResolvedValue({ state }) },
      configurable: true,
    });
  }

  afterEach(() => {
    Object.defineProperty(navigator, "permissions", {
      value: undefined,
      configurable: true,
    });
  });

  it("renvoie false si l'API periodicSync est absente de la registration", async () => {
    setPermission("granted");
    const registration = {} as ServiceWorkerRegistration;
    await expect(registerPeriodicSync(registration)).resolves.toBe(false);
  });

  it("renvoie false (sans register) si la permission n'est pas accordée", async () => {
    setPermission("prompt");
    const register = vi.fn();
    const registration = {
      periodicSync: { register },
    } as unknown as ServiceWorkerRegistration;
    await expect(registerPeriodicSync(registration)).resolves.toBe(false);
    expect(register).not.toHaveBeenCalled();
  });

  it("enregistre le tag boreas-sync quand support + permission OK", async () => {
    setPermission("granted");
    const register = vi.fn().mockResolvedValue(undefined);
    const registration = {
      periodicSync: { register },
    } as unknown as ServiceWorkerRegistration;
    await expect(registerPeriodicSync(registration)).resolves.toBe(true);
    expect(register).toHaveBeenCalledWith(
      PERIODIC_SYNC_TAG,
      expect.objectContaining({ minInterval: expect.any(Number) }),
    );
  });

  it("avale un rejet de register (best-effort) et renvoie false", async () => {
    setPermission("granted");
    const register = vi.fn().mockRejectedValue(new Error("quota"));
    const registration = {
      periodicSync: { register },
    } as unknown as ServiceWorkerRegistration;
    await expect(registerPeriodicSync(registration)).resolves.toBe(false);
  });

  it("avale l'absence de navigator.permissions (renvoie false)", async () => {
    setPermission("absent");
    const register = vi.fn();
    const registration = {
      periodicSync: { register },
    } as unknown as ServiceWorkerRegistration;
    await expect(registerPeriodicSync(registration)).resolves.toBe(false);
    expect(register).not.toHaveBeenCalled();
  });
});
