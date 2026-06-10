import { describe, expect, it } from "vitest";
import {
  chunk,
  D1_MAX_BOUND_PARAMS,
  insertChunkSize,
  whereInChunkSize,
} from "../src/batching";

describe("chunk", () => {
  it("renvoie un tableau vide pour une entrée vide", () => {
    expect(chunk([], 3)).toEqual([]);
  });

  it("découpe en tranches exactes quand la taille divise la longueur", () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("laisse un reste partiel en dernière tranche", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("renvoie une unique tranche quand size ≥ length", () => {
    expect(chunk([1, 2, 3], 10)).toEqual([[1, 2, 3]]);
  });
});

describe("insertChunkSize", () => {
  it("dérive la taille de lot du nombre de colonnes (marge réservée par défaut)", () => {
    // articles : 12 colonnes → floor((100 - 1) / 12) = 8.
    expect(insertChunkSize(12)).toBe(8);
  });

  it("reproduit les tailles de lot actuelles des call-sites", () => {
    expect(insertChunkSize(12)).toBe(8); // articles
    expect(insertChunkSize(4)).toBe(24); // feeds (id, url, title, folder_id)
    expect(insertChunkSize(2)).toBe(49); // folders (id, name)
  });

  it("respecte l'invariant size × colonnes + reserved ≤ 100", () => {
    for (let columns = 1; columns <= 20; columns++) {
      for (const reserved of [0, 1, 16]) {
        const size = insertChunkSize(columns, reserved);
        expect(size * columns + reserved).toBeLessThanOrEqual(
          D1_MAX_BOUND_PARAMS,
        );
      }
    }
  });
});

describe("whereInChunkSize", () => {
  it("réserve les paramètres hors-IN sous la limite D1", () => {
    expect(whereInChunkSize(1)).toBe(99);
    expect(whereInChunkSize(16)).toBe(84);
  });
});
