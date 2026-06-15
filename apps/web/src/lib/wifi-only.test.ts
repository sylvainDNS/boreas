import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getWifiOnly,
  isMeteredConnection,
  setWifiOnly,
  shouldSkipHeavyContent,
} from "./wifi-only";

/** Pose un faux `navigator.connection` (Network Information API) le temps du test. */
function withConnection(connection: unknown, run: () => void): void {
  const nav = navigator as Navigator & { connection?: unknown };
  const original = nav.connection;
  Object.defineProperty(nav, "connection", {
    configurable: true,
    value: connection,
  });
  try {
    run();
  } finally {
    Object.defineProperty(nav, "connection", {
      configurable: true,
      value: original,
    });
  }
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("wifi-only — préférence locale", () => {
  it("est off par défaut", () => {
    expect(getWifiOnly()).toBe(false);
  });

  it("persiste et relit la préférence", () => {
    setWifiOnly(true);
    expect(getWifiOnly()).toBe(true);
    setWifiOnly(false);
    expect(getWifiOnly()).toBe(false);
  });
});

describe("wifi-only — détection de connexion mesurée", () => {
  it("indéterminé (API absente) → non mesurée (ne bloque pas)", () => {
    withConnection(undefined, () => {
      expect(isMeteredConnection()).toBe(false);
    });
  });

  it("type 'cellular' → mesurée", () => {
    withConnection({ type: "cellular" }, () => {
      expect(isMeteredConnection()).toBe(true);
    });
  });

  it("saveData → mesurée", () => {
    withConnection({ saveData: true }, () => {
      expect(isMeteredConnection()).toBe(true);
    });
  });

  it("effectiveType lent (2g/3g) → mesurée", () => {
    withConnection({ effectiveType: "3g" }, () => {
      expect(isMeteredConnection()).toBe(true);
    });
  });

  it("wifi / 4g → non mesurée", () => {
    withConnection({ type: "wifi", effectiveType: "4g" }, () => {
      expect(isMeteredConnection()).toBe(false);
    });
  });
});

describe("wifi-only — gating du contenu lourd", () => {
  it("ne saute PAS si le réglage est off, même sur cellulaire", () => {
    setWifiOnly(false);
    withConnection({ type: "cellular" }, () => {
      expect(shouldSkipHeavyContent()).toBe(false);
    });
  });

  it("ne saute PAS si réglage ON mais connexion non mesurée (Wi-Fi)", () => {
    setWifiOnly(true);
    withConnection({ type: "wifi" }, () => {
      expect(shouldSkipHeavyContent()).toBe(false);
    });
  });

  it("ne saute PAS si réglage ON mais connexion indéterminée (best-effort)", () => {
    setWifiOnly(true);
    withConnection(undefined, () => {
      expect(shouldSkipHeavyContent()).toBe(false);
    });
  });

  it("saute UNIQUEMENT si réglage ON ET connexion mesurée", () => {
    setWifiOnly(true);
    withConnection({ type: "cellular" }, () => {
      expect(shouldSkipHeavyContent()).toBe(true);
    });
  });
});
