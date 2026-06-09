import { describe, expect, it } from "vitest";
import { parseOpml } from "../src/parse";

describe("parseOpml", () => {
  it("rattache un flux à son conteneur immédiat (Folder)", () => {
    const xml = `<?xml version="1.0"?>
      <opml version="2.0">
        <head><title>Export</title></head>
        <body>
          <outline text="Tech" title="Tech">
            <outline type="rss" text="Blog A" xmlUrl="https://a.example/feed"/>
          </outline>
        </body>
      </opml>`;

    const { feeds } = parseOpml(xml);

    expect(feeds).toEqual([
      { url: "https://a.example/feed", title: "Blog A", folderName: "Tech" },
    ]);
  });

  it("laisse folderName null pour un flux à la racine du body", () => {
    const xml = `<opml version="2.0"><body>
      <outline type="rss" text="Solo" xmlUrl="https://solo.example/rss"/>
    </body></opml>`;

    const { feeds } = parseOpml(xml);

    expect(feeds).toEqual([
      { url: "https://solo.example/rss", title: "Solo", folderName: null },
    ]);
  });

  it("aplatit une imbrication profonde sur le conteneur immédiat", () => {
    const xml = `<opml version="2.0"><body>
      <outline text="Tech">
        <outline text="Frontend">
          <outline type="rss" text="React" xmlUrl="https://react.example/feed"/>
        </outline>
      </outline>
    </body></opml>`;

    const { feeds } = parseOpml(xml);

    expect(feeds).toEqual([
      {
        url: "https://react.example/feed",
        title: "React",
        folderName: "Frontend",
      },
    ]);
  });

  it("déduplique par URL (première occurrence gagnante)", () => {
    const xml = `<opml version="2.0"><body>
      <outline text="Tech">
        <outline type="rss" text="Premier" xmlUrl="https://dup.example/feed"/>
      </outline>
      <outline type="rss" text="Second" xmlUrl="https://dup.example/feed"/>
    </body></opml>`;

    const { feeds } = parseOpml(xml);

    expect(feeds).toEqual([
      { url: "https://dup.example/feed", title: "Premier", folderName: "Tech" },
    ]);
  });

  it("ignore les outlines sans xmlUrl http(s) valide", () => {
    const xml = `<opml version="2.0"><body>
      <outline text="Conteneur vide"/>
      <outline type="rss" text="Mauvais" xmlUrl="ftp://nope.example/feed"/>
      <outline type="rss" text="Vide" xmlUrl=""/>
      <outline type="rss" text="Bon" xmlUrl="https://ok.example/feed"/>
    </body></opml>`;

    const { feeds } = parseOpml(xml);

    expect(feeds).toEqual([
      { url: "https://ok.example/feed", title: "Bon", folderName: null },
    ]);
  });

  it("retombe sur title quand text est absent", () => {
    const xml = `<opml version="2.0"><body>
      <outline type="rss" title="Par titre" xmlUrl="https://t.example/feed"/>
    </body></opml>`;

    expect(parseOpml(xml).feeds[0]?.title).toBe("Par titre");
  });

  it("renvoie une liste vide pour un document illisible ou non-OPML", () => {
    expect(parseOpml("pas du xml <<<").feeds).toEqual([]);
    expect(parseOpml("<opml><head/></opml>").feeds).toEqual([]);
    expect(parseOpml("").feeds).toEqual([]);
  });
});
