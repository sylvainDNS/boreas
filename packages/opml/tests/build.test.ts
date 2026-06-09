import { describe, expect, it } from "vitest";
import { buildOpml } from "../src/build";
import { parseOpml } from "../src/parse";

describe("buildOpml", () => {
  it("produit un OPML 2.0 avec déclaration XML et head", () => {
    const xml = buildOpml([], []);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<opml version="2.0">');
    expect(xml).toContain("<title>Boréas</title>");
  });

  it("regroupe les flux sous l'outline conteneur de leur Folder", () => {
    const xml = buildOpml(
      [{ url: "https://a.example/feed", title: "Blog A", folderId: "f1" }],
      [{ id: "f1", name: "Tech" }],
    );
    expect(xml).toContain('text="Tech"');
    expect(xml).toContain('xmlUrl="https://a.example/feed"');
  });

  it("place les flux non classés à la racine", () => {
    const xml = buildOpml(
      [{ url: "https://solo.example/rss", title: null, folderId: null }],
      [],
    );
    // Titre absent → repli sur l'URL.
    expect(xml).toContain('xmlUrl="https://solo.example/rss"');
    expect(xml).toContain('text="https://solo.example/rss"');
  });

  it("round-trip : buildOpml puis parseOpml conserve url/title/folderName", () => {
    const feeds = [
      { url: "https://a.example/feed", title: "Blog A", folderId: "f1" },
      { url: "https://b.example/feed", title: "Blog B", folderId: "f1" },
      { url: "https://c.example/feed", title: "Sans dossier", folderId: null },
    ];
    const folders = [{ id: "f1", name: "Tech" }];

    const { feeds: parsed } = parseOpml(buildOpml(feeds, folders));

    expect(parsed).toEqual([
      { url: "https://a.example/feed", title: "Blog A", folderName: "Tech" },
      { url: "https://b.example/feed", title: "Blog B", folderName: "Tech" },
      {
        url: "https://c.example/feed",
        title: "Sans dossier",
        folderName: null,
      },
    ]);
  });

  it("échappe les caractères XML dans les libellés (round-trip)", () => {
    const { feeds } = parseOpml(
      buildOpml(
        [{ url: "https://x.example/feed", title: "A & B <C>", folderId: null }],
        [],
      ),
    );
    expect(feeds[0]?.title).toBe("A & B <C>");
  });
});
