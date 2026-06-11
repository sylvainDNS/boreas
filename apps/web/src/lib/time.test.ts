import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatRelativeTime } from "./time";

const NOW = new Date("2026-06-10T12:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("formatRelativeTime", () => {
  it("rend un libellé passé relatif", () => {
    expect(formatRelativeTime("2026-06-10T11:46:00.000Z")).toBe(
      "il y a 14 minutes",
    );
  });

  it("replie sur « récemment » quand la date est absente", () => {
    expect(formatRelativeTime(null)).toBe("récemment");
    expect(formatRelativeTime(undefined)).toBe("récemment");
  });

  it("replie sur « récemment » quand la date est illisible", () => {
    expect(formatRelativeTime("pas-une-date")).toBe("récemment");
  });

  it("plafonne cosmétiquement une date future à l'instant présent (ADR 0015)", () => {
    // Flux menteur / décalage d'horloge : on n'affiche jamais « dans 1 an ».
    const future = formatRelativeTime("2027-01-01T00:00:00.000Z");
    expect(future).not.toMatch(/dans/);
    // Plafonné à now → durée nulle → « maintenant ».
    expect(future).toBe("maintenant");
  });
});
