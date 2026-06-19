import { rankBetween } from "@boreas/shared/rank";
import { describe, expect, it } from "vitest";
import type { Feed } from "../../lib/feeds";
import type { Folder } from "../../lib/folders";
import {
  type FeedDragSource,
  groupFeedsByFolder,
  resolveDropTarget,
  resolveFeedDragEnd,
  UNFILED_DROPPABLE_ID,
} from "./sidebar-model";

/** Fabrique un Feed minimal (champs non pertinents au regroupement figés). */
function makeFeed(id: string, folderId: string | null): Feed {
  return {
    id,
    url: `https://example.com/${id}`,
    title: id,
    status: "ok",
    lastError: null,
    lastCheckAt: null,
    folderId,
    rank: "a0",
  };
}

/** Fabrique un Folder minimal. */
function makeFolder(id: string, rank = "a0"): Folder {
  return { id, name: id, rank };
}

describe("groupFeedsByFolder", () => {
  it("regroupe les feeds par folderId connu et liste les autres « sans dossier »", () => {
    const folders = [makeFolder("a"), makeFolder("b")];
    const feeds = [
      makeFeed("f1", "a"),
      makeFeed("f2", "a"),
      makeFeed("f3", "b"),
      makeFeed("f4", null),
    ];

    const { feedsByFolder, unfiledFeeds } = groupFeedsByFolder(folders, feeds);

    expect(feedsByFolder.get("a")?.map((f) => f.id)).toEqual(["f1", "f2"]);
    expect(feedsByFolder.get("b")?.map((f) => f.id)).toEqual(["f3"]);
    expect(unfiledFeeds.map((f) => f.id)).toEqual(["f4"]);
  });

  it("traite un folderId inconnu (folder supprimé/non chargé) comme « sans dossier »", () => {
    const folders = [makeFolder("a")];
    const feeds = [makeFeed("f1", "ghost"), makeFeed("f2", "a")];

    const { feedsByFolder, unfiledFeeds } = groupFeedsByFolder(folders, feeds);

    expect(feedsByFolder.get("a")?.map((f) => f.id)).toEqual(["f2"]);
    expect(feedsByFolder.has("ghost")).toBe(false);
    expect(unfiledFeeds.map((f) => f.id)).toEqual(["f1"]);
  });

  it("préserve l'ordre des feeds au sein d'un dossier et des « sans dossier »", () => {
    const folders = [makeFolder("a")];
    const feeds = [
      makeFeed("z", "a"),
      makeFeed("u1", null),
      makeFeed("a", "a"),
      makeFeed("u2", null),
    ];

    const { feedsByFolder, unfiledFeeds } = groupFeedsByFolder(folders, feeds);

    expect(feedsByFolder.get("a")?.map((f) => f.id)).toEqual(["z", "a"]);
    expect(unfiledFeeds.map((f) => f.id)).toEqual(["u1", "u2"]);
  });
});

describe("resolveDropTarget", () => {
  it("traduit la sentinelle « sans dossier » en null (désassignation)", () => {
    expect(resolveDropTarget(UNFILED_DROPPABLE_ID)).toBeNull();
  });

  it("renvoie tel quel un id de Folder réel", () => {
    expect(resolveDropTarget("tech")).toBe("tech");
  });
});

describe("resolveFeedDragEnd (#111 reorder vs #13 move)", () => {
  // Conteneur sans dossier : f1, f2, f3 (rangs croissants).
  const unfiled = (() => {
    let prev: string | null = null;
    return ["f1", "f2", "f3"].map((id) => {
      const rank = rankBetween(prev, null);
      prev = rank;
      return { ...makeFeed(id, null), rank };
    });
  })();
  const lookup = (folderId: string | null) =>
    folderId === null ? unfiled : [];

  /** Rang du feed à l'index donné (lève si absent — évite `!` dans les tests). */
  function rankAt(index: number): string {
    const feed = unfiled[index];
    if (!feed) throw new Error(`no feed at index ${index}`);
    return feed.rank;
  }

  const sortableSource = (over: Partial<FeedDragSource>): FeedDragSource => ({
    id: "f1",
    isSortable: true,
    initialGroup: UNFILED_DROPPABLE_ID,
    group: UNFILED_DROPPABLE_ID,
    initialIndex: 0,
    index: 0,
    folderId: null,
    ...over,
  });

  it("même group (initialGroup === group) : REORDER avec un rang entre voisins", () => {
    // Déplace f1 (index 0) en position 1 dans la zone sans dossier.
    const action = resolveFeedDragEnd(
      sortableSource({ id: "f1", initialIndex: 0, index: 1 }),
      null,
      lookup,
    );
    expect(action.kind).toBe("reorder");
    if (action.kind !== "reorder") throw new Error("reorder attendu");
    expect(action.id).toBe("f1");
    // Rang entre f2 et f3.
    expect(rankAt(1) < action.rank).toBe(true);
    expect(action.rank < rankAt(2)).toBe(true);
  });

  it("reorder no-op (from === to) : action none (pas de mutation)", () => {
    const action = resolveFeedDragEnd(
      sortableSource({ initialIndex: 1, index: 1 }),
      null,
      lookup,
    );
    expect(action.kind).toBe("none");
  });

  it("group différent (cible autre conteneur) : MOVE vers le folder cible (#13)", () => {
    // f1 part de la zone sans dossier (initialGroup) vers le dossier "tech".
    const action = resolveFeedDragEnd(
      sortableSource({
        id: "f1",
        folderId: null,
        initialGroup: UNFILED_DROPPABLE_ID,
        group: "tech",
      }),
      "tech",
      lookup,
    );
    expect(action).toEqual({ kind: "move", id: "f1", folderId: "tech" });
  });

  it("move vers le conteneur courant (folderId identique) : none (#13)", () => {
    const action = resolveFeedDragEnd(
      sortableSource({
        id: "f1",
        folderId: "tech",
        initialGroup: "tech",
        group: UNFILED_DROPPABLE_ID,
      }),
      "tech",
      lookup,
    );
    expect(action.kind).toBe("none");
  });

  it("source non sortable mais avec cible : MOVE (repli #13)", () => {
    const action = resolveFeedDragEnd(
      { id: "f1", isSortable: false, folderId: null },
      "tech",
      lookup,
    );
    expect(action).toEqual({ kind: "move", id: "f1", folderId: "tech" });
  });

  it("sans cible et group différent : none (drop hors zone)", () => {
    const action = resolveFeedDragEnd(
      { id: "f1", isSortable: false, folderId: null },
      undefined,
      lookup,
    );
    expect(action.kind).toBe("none");
  });
});
