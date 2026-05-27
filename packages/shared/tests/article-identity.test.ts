import { describe, expect, it } from "vitest";
import { articleKey, type ArticleItem } from "../src/article-identity";
import { loadFixture } from "./helpers/load-fixture";

interface Fixture {
  item: ArticleItem;
  feedId: string;
  expectedPrefix: string;
}

describe("articleKey", () => {
  // --- Tests par fixtures (pattern de référence) ---

  it("utilise le guid quand il est présent", () => {
    const { item, feedId, expectedPrefix } = loadFixture<Fixture>(
      "article-identity/with-guid.json",
    );
    const key = articleKey(item, feedId);
    expect(key).toMatch(new RegExp(`^${expectedPrefix}`));
    expect(key).toBe(`guid:${item.guid}`);
  });

  it("utilise le link quand il n'y a pas de guid", () => {
    const { item, feedId, expectedPrefix } = loadFixture<Fixture>(
      "article-identity/with-link-only.json",
    );
    const key = articleKey(item, feedId);
    expect(key).toMatch(new RegExp(`^${expectedPrefix}`));
    expect(key).toBe(`link:${item.link}`);
  });

  it("produit un hash quand ni guid ni link", () => {
    const { item, feedId, expectedPrefix } = loadFixture<Fixture>(
      "article-identity/no-guid-no-link.json",
    );
    const key = articleKey(item, feedId);
    expect(key).toMatch(new RegExp(`^${expectedPrefix}`));
    expect(key).toMatch(/^hash:[0-9a-f]{32}$/);
  });

  // --- Tests de comportement inline ---

  it("guid a priorité sur link", () => {
    expect(
      articleKey({ guid: "g1", link: "https://example.com/1" }, "f1"),
    ).toBe("guid:g1");
  });

  it("le hash est stable (mêmes entrées → même clé)", () => {
    const item: ArticleItem = { title: "Mon Article", content: "<p>Bonjour</p>" };
    expect(articleKey(item, "feed-1")).toBe(articleKey(item, "feed-1"));
  });

  it("le hash change selon le feedId", () => {
    const item: ArticleItem = { title: "Article partagé" };
    expect(articleKey(item, "feed-1")).not.toBe(articleKey(item, "feed-2"));
  });

  it("un guid vide est ignoré (repli sur link)", () => {
    expect(
      articleKey({ guid: "  ", link: "https://example.com/2" }, "f1"),
    ).toBe("link:https://example.com/2");
  });

  it("un link vide est ignoré (repli sur hash)", () => {
    const key = articleKey({ guid: null, link: "", title: "T" }, "f1");
    expect(key).toMatch(/^hash:[0-9a-f]{32}$/);
  });
});
