import { describe, expect, it } from "vitest";
import { extractArticle } from "../src/extractor";
import { loadFixture } from "./helpers/load-fixture";

describe("extractArticle", () => {
  it("extrait le contenu principal d'une page et écarte le chrome", () => {
    const html = loadFixture("article-with-chrome.html");
    const result = extractArticle(
      html,
      "https://magazine.example/vent-du-nord",
    );

    // Le corps de l'article est conservé.
    expect(result.content).toContain("le vent du nord descend des massifs");
    expect(result.content).toContain("nom grec de ce");
    expect(result.title).toContain("Le vent du nord");

    // La navigation, la publicité et le pied de page sont retirés.
    expect(result.content).not.toContain("PUBLICITÉ");
    expect(result.content).not.toContain("Mentions légales");
    expect(result.content).not.toContain("S'abonner");
  });

  it("résout les URLs d'images relatives contre l'URL de base", () => {
    const html = loadFixture("article-with-chrome.html");
    const result = extractArticle(
      html,
      "https://magazine.example/vent-du-nord",
    );

    expect(result.content).toContain(
      "https://magazine.example/photos/sommet-enneige.jpg",
    );
  });

  it("retombe sur le HTML brut quand Readability ne trouve rien d'exploitable", () => {
    const fragment = "<p>Trop court pour Readability.</p>";
    const result = extractArticle(fragment, "https://src.example/court");

    expect(result.content).toBe(fragment);
    expect(result.title).toBeNull();
  });

  it("retombe sur le HTML brut sur entrée non parsable plutôt que de lever", () => {
    const result = extractArticle("", "https://src.example/vide");
    expect(result.content).toBe("");
  });
});
