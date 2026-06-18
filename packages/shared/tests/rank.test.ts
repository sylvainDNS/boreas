import { describe, expect, it } from "vitest";
import { initialRanks, rankBetween, ranksAfter } from "../src/rank";

describe("rankBetween (ADR 0020)", () => {
  it("produit une première clé quand il n'y a aucun voisin", () => {
    const r = rankBetween(null, null);
    expect(typeof r).toBe("string");
    expect(r.length).toBeGreaterThan(0);
  });

  it("range après un prédécesseur (insertion en fin de liste)", () => {
    const first = rankBetween(null, null);
    const second = rankBetween(first, null);
    expect(second > first).toBe(true);
  });

  it("range avant un successeur (insertion en tête de liste)", () => {
    const last = rankBetween(null, null);
    const before = rankBetween(null, last);
    expect(before < last).toBe(true);
  });

  it("intercale strictement entre deux voisins adjacents", () => {
    const a = rankBetween(null, null);
    const b = rankBetween(a, null);
    const mid = rankBetween(a, b);
    expect(mid > a).toBe(true);
    expect(mid < b).toBe(true);
  });

  it("permet des intercalations répétées sans collision (ordre stable)", () => {
    const lo = rankBetween(null, null);
    let hi = rankBetween(lo, null);
    for (let i = 0; i < 50; i++) {
      const mid = rankBetween(lo, hi);
      expect(mid > lo).toBe(true);
      expect(mid < hi).toBe(true);
      hi = mid; // on resserre toujours par le haut
    }
    expect(hi > lo).toBe(true);
  });
});

describe("initialRanks (backfill ordonné)", () => {
  it("renvoie un tableau vide pour n = 0", () => {
    expect(initialRanks(0)).toEqual([]);
  });

  it("renvoie n clés strictement croissantes", () => {
    const ranks = initialRanks(5);
    expect(ranks).toHaveLength(5);
    expect([...ranks].sort()).toEqual(ranks);
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it("produit des clés fractional-indexing VALIDES : rankBetween intercale entre deux clés backfillées adjacentes", () => {
    // Régression (issue #108) : le backfill doit produire des clés réutilisables
    // par rankBetween, pas un zéro-pad maison qui casserait les insertions futures.
    const ranks = initialRanks(4);
    for (let i = 1; i < ranks.length; i++) {
      const before = ranks[i - 1] as string;
      const after = ranks[i] as string;
      const mid = rankBetween(before, after);
      expect(mid > before).toBe(true);
      expect(mid < after).toBe(true);
    }
  });
});

describe("ranksAfter (insertion en lot en fin de liste)", () => {
  it("renvoie un tableau vide pour n = 0", () => {
    expect(ranksAfter("a0", 0)).toEqual([]);
    expect(ranksAfter(null, 0)).toEqual([]);
  });

  it("place n clés croissantes après lastRank", () => {
    const last = "a0";
    const next = ranksAfter(last, 3);
    expect(next).toHaveLength(3);
    // Toutes > lastRank et strictement croissantes (ordre stable).
    expect(next.every((r) => r > last)).toBe(true);
    expect([...next].sort()).toEqual(next);
    expect(new Set(next).size).toBe(next.length);
  });

  it("part de zéro quand lastRank est null", () => {
    const next = ranksAfter(null, 2);
    expect(next).toHaveLength(2);
    expect([...next].sort()).toEqual(next);
    expect(new Set(next).size).toBe(2);
  });
});
