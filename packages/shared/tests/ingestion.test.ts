import { afterEach, describe, expect, it, vi } from "vitest";
import { buildConditionalHeaders, computeNextCheckAt } from "../src/ingestion";

describe("buildConditionalHeaders", () => {
  it("n'ajoute aucun en-tête conditionnel sans validateur connu", () => {
    const headers = buildConditionalHeaders(null, null);
    expect(headers["if-none-match"]).toBeUndefined();
    expect(headers["if-modified-since"]).toBeUndefined();
    // Les en-têtes de base (UA / Accept) restent présents.
    expect(headers["user-agent"]).toContain("Boreas");
    expect(headers.accept).toContain("rss");
  });

  it("rejoue l'ETag en If-None-Match", () => {
    const headers = buildConditionalHeaders('"abc123"', null);
    expect(headers["if-none-match"]).toBe('"abc123"');
    expect(headers["if-modified-since"]).toBeUndefined();
  });

  it("rejoue le Last-Modified en If-Modified-Since", () => {
    const lm = "Wed, 21 Oct 2026 07:28:00 GMT";
    const headers = buildConditionalHeaders(null, lm);
    expect(headers["if-modified-since"]).toBe(lm);
    expect(headers["if-none-match"]).toBeUndefined();
  });

  it("rejoue les deux validateurs quand ils sont connus", () => {
    const headers = buildConditionalHeaders('"e"', "lm");
    expect(headers["if-none-match"]).toBe('"e"');
    expect(headers["if-modified-since"]).toBe("lm");
  });
});

describe("computeNextCheckAt", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("place l'échéance au moins à now + intervalle", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const now = new Date("2026-06-05T12:00:00Z");
    expect(computeNextCheckAt(30, now)).toBe("2026-06-05T12:30:00Z");
  });

  it("ajoute un jitter borné à 25 % de l'intervalle", () => {
    // random=1 (borne haute) → +30 min + 25 % de 30 min = +37 min 30 s.
    vi.spyOn(Math, "random").mockReturnValue(1);
    const now = new Date("2026-06-05T12:00:00Z");
    expect(computeNextCheckAt(30, now)).toBe("2026-06-05T12:37:30Z");
  });

  it("renvoie un horodatage au format SQL (sans millisecondes)", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const result = computeNextCheckAt(30, new Date("2026-06-05T12:00:00Z"));
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});
