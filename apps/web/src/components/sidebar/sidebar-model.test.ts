import { describe, expect, it } from "vitest";
import type { Feed } from "../../lib/feeds";
import type { Folder } from "../../lib/folders";
import {
  groupFeedsByFolder,
  resolveDropTarget,
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
