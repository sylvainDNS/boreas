import { rankBetween } from "@boreas/shared/rank";
import { describe, expect, it } from "vitest";
import type { Feed } from "../../lib/feeds";
import { computeFeedRank, rankAtInsertion } from "./feed-reorder";

/**
 * Construit une liste de Feeds (d'un même conteneur) dont les rangs sont
 * strictement croissants (clés fractional-indexing valides, ADR 0020), pour des
 * assertions d'ordre. Le `folderId` est sans importance ici : `computeFeedRank`
 * ne raisonne que sur l'ordre de la liste fournie (celle du conteneur).
 */
function feeds(ids: string[]): Feed[] {
  let prev: string | null = null;
  return ids.map((id) => {
    const rank = rankBetween(prev, null);
    prev = rank;
    return {
      id,
      url: `https://src.example/${id}.xml`,
      title: id,
      status: "ok",
      lastError: null,
      lastCheckAt: null,
      folderId: null,
      rank,
    } satisfies Feed;
  });
}

/** Rang du Feed à l'index donné (lève si absent — évite `!` dans les tests). */
function rankAt(list: readonly Feed[], index: number): string {
  const feed = list[index];
  if (!feed) throw new Error(`no feed at index ${index}`);
  return feed.rank;
}

describe("computeFeedRank", () => {
  it("no-op : from === to renvoie null (aucune mutation)", () => {
    const list = feeds(["a", "b", "c"]);
    expect(computeFeedRank(list, 1, 1)).toBeNull();
  });

  it("descente : insère entre les bons voisins de la liste réordonnée", () => {
    const list = feeds(["a", "b", "c", "d"]);
    // On déplace "a" (index 0) en position 2 → ordre attendu b, c, a, d.
    const rank = computeFeedRank(list, 0, 2);
    expect(rank).not.toBeNull();
    const c = rankAt(list, 2);
    const d = rankAt(list, 3);
    expect(c < (rank ?? "")).toBe(true);
    expect((rank ?? "") < d).toBe(true);
  });

  it("montée : insère entre les bons voisins (retrait avant lecture)", () => {
    const list = feeds(["a", "b", "c", "d"]);
    // On déplace "d" (index 3) en position 1 → ordre attendu a, d, b, c.
    const rank = computeFeedRank(list, 3, 1);
    expect(rank).not.toBeNull();
    const a = rankAt(list, 0);
    const b = rankAt(list, 1);
    expect(a < (rank ?? "")).toBe(true);
    expect((rank ?? "") < b).toBe(true);
  });

  it("tête : toIndex=0, before=null → rang avant le premier", () => {
    const list = feeds(["a", "b", "c"]);
    // On déplace "c" (index 2) en tête → before=null, after=a.
    const rank = computeFeedRank(list, 2, 0);
    expect(rank).not.toBeNull();
    const a = rankAt(list, 0);
    expect((rank ?? "") < a).toBe(true);
  });

  it("queue : after=null → rang après le dernier", () => {
    const list = feeds(["a", "b", "c"]);
    // On déplace "a" (index 0) en fin → before=c, after=null.
    const rank = computeFeedRank(list, 0, 2);
    expect(rank).not.toBeNull();
    const c = rankAt(list, 2);
    expect(c < (rank ?? "")).toBe(true);
  });

  it("liste à 1 feed : from===to (0,0) → null", () => {
    const list = feeds(["a"]);
    expect(computeFeedRank(list, 0, 0)).toBeNull();
  });

  it("voisins encadrants de rang égal : abandonne (null, pas de crash)", () => {
    // GET départage par id quand deux Feeds partagent un rang (ADR 0018) : ce
    // cas dégénéré ne doit pas faire lever rankBetween.
    const list: Feed[] = [
      { ...feeds(["x"])[0], id: "a", rank: "a0" },
      { ...feeds(["x"])[0], id: "b", rank: "a1" },
      { ...feeds(["x"])[0], id: "c", rank: "a1" },
      { ...feeds(["x"])[0], id: "d", rank: "a2" },
    ] as Feed[];
    // Déplace "a" (index 0) en position 1 → liste réordonnée [b, a, c, d] :
    // voisins encadrants b (a1) et c (a1), rangs égaux → non intercalable.
    expect(computeFeedRank(list, 0, 1)).toBeNull();
  });

  it("renvoie une clé strictement entre before et after (descente d'un cran)", () => {
    const list = feeds(["a", "b", "c"]);
    const rank = computeFeedRank(list, 0, 1);
    expect(rank).not.toBeNull();
    const b = rankAt(list, 1);
    const c = rankAt(list, 2);
    expect(b < (rank ?? "")).toBe(true);
    expect((rank ?? "") < c).toBe(true);
  });
});

describe("rankAtInsertion (#112 dépose inter-conteneur à position précise)", () => {
  it("insertion en milieu : rang strictement entre les voisins encadrants", () => {
    const list = feeds(["a", "b", "c"]);
    // Insère un item venu d'un AUTRE conteneur à l'index 1 (entre a et b).
    const rank = rankAtInsertion(list, 1);
    expect(rank).not.toBeNull();
    const a = rankAt(list, 0);
    const b = rankAt(list, 1);
    expect(a < (rank ?? "")).toBe(true);
    expect((rank ?? "") < b).toBe(true);
  });

  it("tête (index=0) : before=null → rang avant le premier", () => {
    const list = feeds(["a", "b", "c"]);
    const rank = rankAtInsertion(list, 0);
    expect(rank).not.toBeNull();
    const a = rankAt(list, 0);
    expect((rank ?? "") < a).toBe(true);
  });

  it("queue (index=len) : after=null → rang après le dernier", () => {
    const list = feeds(["a", "b", "c"]);
    const rank = rankAtInsertion(list, list.length);
    expect(rank).not.toBeNull();
    const last = rankAt(list, list.length - 1);
    expect(last < (rank ?? "")).toBe(true);
  });

  it("conteneur cible vide : rankBetween(null, null) → une clé non nulle", () => {
    const rank = rankAtInsertion([], 0);
    expect(rank).not.toBeNull();
    expect(typeof rank).toBe("string");
  });

  it("voisins encadrants de rang égal/inversé : abandonne (null, pas de crash)", () => {
    // Deux feeds du conteneur cible partagent un rang (ADR 0018) : on insère
    // entre eux (index 1) → before (a1) >= after (a1), non intercalable.
    const list: Feed[] = [
      { ...feeds(["x"])[0], id: "a", rank: "a1" },
      { ...feeds(["x"])[0], id: "b", rank: "a1" },
    ] as Feed[];
    expect(rankAtInsertion(list, 1)).toBeNull();
  });
});
