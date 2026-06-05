import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { articleKey } from "../src/article-identity";
import {
  type ParsedFeed,
  type ParsedItem,
  parseFeed,
} from "../src/feed-parser";

const FIXTURES = join(import.meta.dirname, "../fixtures/feed-parser");

/** Charge une fixture en octets bruts (l'encodage est détecté par le parser). */
function bytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

/** Item à un index donné, en échouant explicitement s'il manque (strict TS). */
function nth(feed: ParsedFeed, index: number): ParsedItem {
  const item = feed.items[index];
  if (!item) throw new Error(`pas d'item à l'index ${index}`);
  return item;
}

describe("parseFeed — RSS", () => {
  it("extrait titre du flux et items (guid, link, title, content, date)", () => {
    const feed = parseFeed(bytes("rss-basic.xml"), "application/rss+xml");

    expect(feed.title).toBe("Blog de démonstration");
    expect(feed.items).toHaveLength(2);

    const first = nth(feed, 0);
    const second = nth(feed, 1);
    expect(first.guid).toBe("article-0001");
    expect(first.link).toBe("https://example.com/articles/1");
    expect(first.title).toBe("Premier article — accents éàù");
    expect(first.content).toContain("une entité"); // entités XML décodées
    expect(first.summary).toContain("Un résumé");
    expect(first.publishedAt).toBe("2026-06-02T08:30:00.000Z");

    // content:encoded en CDATA est préféré à description.
    expect(second.content).toContain("<strong>riche</strong>");
    // pubDate avec décalage +0200 → normalisé en UTC.
    expect(second.publishedAt).toBe("2026-06-03T08:00:00.000Z");
  });
});

describe("parseFeed — Atom", () => {
  it("extrait id, link alternate, content et date", () => {
    const feed = parseFeed(bytes("atom-basic.xml"), "application/atom+xml");

    expect(feed.title).toBe("Flux Atom de démonstration");
    expect(feed.items).toHaveLength(1);

    const entry = nth(feed, 0);
    expect(entry.guid).toBe("urn:uuid:1225c695-cfb8-4ebb-aaaa-80da344efa6a");
    // link alternate, jamais le rel="self" ni rel="enclosure".
    expect(entry.link).toBe("https://example.com/atom/1");
    expect(entry.title).toBe("Article Atom");
    expect(entry.content).toContain("Contenu de l'entrée Atom");
    expect(entry.publishedAt).toBe("2026-06-01T12:00:00.000Z");
  });

  it("remonte l'enclosure Atom (link rel=enclosure) en métadonnée", () => {
    const entry = nth(parseFeed(bytes("atom-basic.xml")), 0);
    expect(entry.enclosures).toEqual([
      {
        url: "https://example.com/audio/1.mp3",
        type: "audio/mpeg",
        length: 12345,
      },
    ]);
  });
});

describe("parseFeed — encodages", () => {
  it("décode ISO-8859-1 (latin-1) d'après la déclaration XML", () => {
    const feed = parseFeed(bytes("rss-latin1.xml"));
    expect(feed.title).toBe("Café littéraire");
    const item = nth(feed, 0);
    expect(item.title).toBe("Crème brûlée à la française");
    expect(item.summary).toBe("Déjà vu, où êtes-vous ?");
  });

  it("décode windows-1252 (€ 0x80, ’ 0x92)", () => {
    const feed = parseFeed(bytes("rss-windows1252.xml"));
    expect(feed.title).toContain("€");
    const item = nth(feed, 0);
    expect(item.title).toContain("’"); // apostrophe typographique
    expect(item.summary).toContain("€");
  });

  it("le charset du Content-Type prime sur la déclaration", () => {
    // Octets latin-1 mais déclaration ISO-8859-1 : un Content-Type correct
    // doit donner le même résultat (cohérence de la cascade).
    const feed = parseFeed(
      bytes("rss-latin1.xml"),
      "application/rss+xml; charset=iso-8859-1",
    );
    expect(feed.title).toBe("Café littéraire");
  });
});

describe("parseFeed — dates", () => {
  it("publishedAt null quand la date est absente", () => {
    const item = nth(parseFeed(bytes("rss-no-date.xml")), 0);
    expect(item.publishedAt).toBeNull();
  });

  it("conserve une date future telle quelle", () => {
    const item = nth(parseFeed(bytes("rss-future-date.xml")), 0);
    expect(item.publishedAt).toBe("2106-01-01T00:00:00.000Z");
  });
});

describe("parseFeed — enclosures RSS", () => {
  it("remonte url/type/length de l'enclosure", () => {
    const item = nth(parseFeed(bytes("rss-enclosure.xml")), 0);
    expect(item.enclosures).toEqual([
      {
        url: "https://example.com/media/1.mp3",
        type: "audio/mpeg",
        length: 9876543,
      },
    ]);
  });
});

describe("parseFeed — robustesse", () => {
  it("renvoie un flux vide sur un document non reconnu", () => {
    const garbage = new TextEncoder().encode(
      "<html><body>pas un flux</body></html>",
    );
    expect(parseFeed(garbage)).toEqual({ title: null, items: [] });
  });

  it("les items produits sont compatibles avec articleKey", () => {
    const item = nth(parseFeed(bytes("rss-basic.xml")), 0);
    // guid présent → clé déterministe préfixée guid:.
    expect(articleKey(item, "feed-1")).toBe("guid:article-0001");
  });
});
