import { rankBetween } from "@boreas/shared/rank";
import { describe, expect, it } from "vitest";
import type { Folder } from "../../lib/folders";
import { computeFolderRank } from "./folder-reorder";

/**
 * Construit une liste de Folders dont les rangs sont strictement croissants
 * (clés fractional-indexing valides, ADR 0020), pour des assertions d'ordre.
 */
function folders(names: string[]): Folder[] {
  // Rangs initiaux croissants ; on enchaîne `rankBetween(prev, null)`.
  let prev: string | null = null;
  return names.map((name) => {
    const rank = rankBetween(prev, null);
    prev = rank;
    return { id: name, name, rank };
  });
}

/** Rang du Folder à l'index donné (lève si absent — évite `!` dans les tests). */
function rankAt(list: readonly Folder[], index: number): string {
  const folder = list[index];
  if (!folder) throw new Error(`no folder at index ${index}`);
  return folder.rank;
}

describe("computeFolderRank", () => {
  it("no-op : from === to renvoie null (aucune mutation)", () => {
    const list = folders(["a", "b", "c"]);
    expect(computeFolderRank(list, 1, 1)).toBeNull();
  });

  it("descente : insère entre les bons voisins de la liste réordonnée", () => {
    const list = folders(["a", "b", "c", "d"]);
    // On déplace "a" (index 0) en position 2 → ordre attendu b, c, a, d.
    const rank = computeFolderRank(list, 0, 2);
    expect(rank).not.toBeNull();
    const c = rankAt(list, 2);
    const d = rankAt(list, 3);
    // a s'insère entre c et d.
    expect(c < (rank ?? "")).toBe(true);
    expect((rank ?? "") < d).toBe(true);
  });

  it("montée : insère entre les bons voisins (retrait avant lecture)", () => {
    const list = folders(["a", "b", "c", "d"]);
    // On déplace "d" (index 3) en position 1 → ordre attendu a, d, b, c.
    const rank = computeFolderRank(list, 3, 1);
    expect(rank).not.toBeNull();
    const a = rankAt(list, 0);
    const b = rankAt(list, 1);
    // d s'insère entre a et b.
    expect(a < (rank ?? "")).toBe(true);
    expect((rank ?? "") < b).toBe(true);
  });

  it("tête : toIndex=0, before=null → rang avant le premier", () => {
    const list = folders(["a", "b", "c"]);
    // On déplace "c" (index 2) en tête → before=null, after=a.
    const rank = computeFolderRank(list, 2, 0);
    expect(rank).not.toBeNull();
    const a = rankAt(list, 0);
    expect((rank ?? "") < a).toBe(true);
  });

  it("queue : after=null → rang après le dernier", () => {
    const list = folders(["a", "b", "c"]);
    // On déplace "a" (index 0) en fin → before=c, after=null.
    const rank = computeFolderRank(list, 0, 2);
    expect(rank).not.toBeNull();
    const c = rankAt(list, 2);
    expect(c < (rank ?? "")).toBe(true);
  });

  it("liste à 1 dossier : from===to (0,0) → null", () => {
    const list = folders(["a"]);
    expect(computeFolderRank(list, 0, 0)).toBeNull();
  });

  it("voisins encadrants de rang égal : abandonne (null, pas de crash)", () => {
    // GET départage par id quand deux Folders partagent un rang (ADR 0018) : ce
    // cas dégénéré ne doit pas faire lever rankBetween.
    const list: Folder[] = [
      { id: "a", name: "Alpha", rank: "a0" },
      { id: "b", name: "Bravo", rank: "a1" },
      { id: "c", name: "Charlie", rank: "a1" },
      { id: "d", name: "Delta", rank: "a2" },
    ];
    // Déplace "a" (index 0) en position 1 → liste réordonnée [b, a, c, d] :
    // les voisins encadrants sont b (a1) et c (a1), rangs égaux → non intercalable.
    expect(computeFolderRank(list, 0, 1)).toBeNull();
  });

  it("renvoie une clé strictement entre before et after (descente d'un cran)", () => {
    const list = folders(["a", "b", "c"]);
    // Déplace "a" en position 1 → ordre b, a, c ; a entre b et c.
    const rank = computeFolderRank(list, 0, 1);
    expect(rank).not.toBeNull();
    const b = rankAt(list, 1);
    const c = rankAt(list, 2);
    expect(b < (rank ?? "")).toBe(true);
    expect((rank ?? "") < c).toBe(true);
  });
});
