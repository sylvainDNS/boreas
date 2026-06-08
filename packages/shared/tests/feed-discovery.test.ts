import { describe, expect, it } from "vitest";
import { discoverFeeds } from "../src/feed-discovery";

const SITE = "https://example.com/blog/";

/** Page HTML minimale dont on injecte le contenu de `<head>`. */
function page(head: string): string {
  return `<!doctype html><html><head>${head}</head><body><p>hi</p></body></html>`;
}

describe("discoverFeeds — 0 candidat", () => {
  it("renvoie [] quand aucun <link> pertinent", () => {
    const html = page(
      `<title>Sans flux</title><link rel="stylesheet" href="/app.css">`,
    );
    expect(discoverFeeds(html, SITE)).toEqual([]);
  });

  it("ignore les <link> de type non-flux ou rel non-alternate", () => {
    const html = page(
      `<link rel="alternate" type="application/xml" href="/x.xml">
       <link rel="icon" type="application/rss+xml" href="/not-a-feed">
       <link rel="canonical" href="https://example.com/">`,
    );
    expect(discoverFeeds(html, SITE)).toEqual([]);
  });
});

describe("discoverFeeds — 1 candidat", () => {
  it("résout l'URL, déduit le type et reprend le title", () => {
    const html = page(
      `<link rel="alternate" type="application/rss+xml" title="Flux RSS" href="https://example.com/feed.xml">`,
    );
    expect(discoverFeeds(html, SITE)).toEqual([
      { url: "https://example.com/feed.xml", title: "Flux RSS", type: "rss" },
    ]);
  });

  it("résout un href relatif contre l'URL de la page", () => {
    const html = page(
      `<link rel="alternate" type="application/atom+xml" href="atom.xml">`,
    );
    expect(discoverFeeds(html, SITE)).toEqual([
      { url: "https://example.com/blog/atom.xml", title: null, type: "atom" },
    ]);
  });

  it("accepte rel multi-jetons et insensible à la casse", () => {
    const html = page(
      `<link rel="Alternate Home" type="APPLICATION/RSS+XML" href="/feed">`,
    );
    expect(discoverFeeds(html, SITE)).toEqual([
      { url: "https://example.com/feed", title: null, type: "rss" },
    ]);
  });
});

describe("discoverFeeds — N candidats", () => {
  it("retourne tous les flux, ordre du document conservé, types distincts", () => {
    const html = page(
      `<link rel="alternate" type="application/rss+xml" title="RSS" href="/rss.xml">
       <link rel="alternate" type="application/atom+xml" title="Atom" href="/atom.xml">`,
    );
    expect(discoverFeeds(html, SITE)).toEqual([
      { url: "https://example.com/rss.xml", title: "RSS", type: "rss" },
      { url: "https://example.com/atom.xml", title: "Atom", type: "atom" },
    ]);
  });

  it("dédoublonne par URL résolue (premier gagnant)", () => {
    const html = page(
      `<link rel="alternate" type="application/rss+xml" title="Premier" href="/feed.xml">
       <link rel="alternate" type="application/rss+xml" title="Doublon" href="https://example.com/feed.xml">`,
    );
    expect(discoverFeeds(html, SITE)).toEqual([
      { url: "https://example.com/feed.xml", title: "Premier", type: "rss" },
    ]);
  });

  it("ignore les liens sans href ou non-http(s)", () => {
    const html = page(
      `<link rel="alternate" type="application/rss+xml" href="/ok.xml">
       <link rel="alternate" type="application/rss+xml">
       <link rel="alternate" type="application/atom+xml" href="ftp://example.com/bad.xml">`,
    );
    expect(discoverFeeds(html, SITE)).toEqual([
      { url: "https://example.com/ok.xml", title: null, type: "rss" },
    ]);
  });
});
