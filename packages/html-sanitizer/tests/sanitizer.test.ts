import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "../src/sanitizer";

/** Stub de signature : rend l'URL signée vérifiable sans secret réel. */
const signImageSrc = (src: string) =>
  `/api/img?u=${encodeURIComponent(src)}&sig=stub`;

describe("sanitizeHtml", () => {
  it("retire les balises <script>", () => {
    const out = sanitizeHtml("<p>Bonjour</p><script>alert('xss')</script>", {
      signImageSrc,
    });
    expect(out).toContain("Bonjour");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert");
  });

  it("retire les gestionnaires d'événements inline", () => {
    const out = sanitizeHtml(
      `<img src="https://src.example/x.jpg" onerror="steal()" /><p onclick="boom()">hey</p>`,
      { signImageSrc },
    );
    expect(out).not.toContain("onerror");
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("steal");
  });

  it("retire les liens en schéma javascript:", () => {
    const out = sanitizeHtml(`<a href="javascript:alert(1)">clic</a>`, {
      signImageSrc,
    });
    expect(out).not.toContain("javascript:");
  });

  it("réécrit et signe les src d'images (résolues en absolu)", () => {
    const out = sanitizeHtml(`<p><img src="/photos/a.jpg" alt="A" /></p>`, {
      baseUrl: "https://magazine.example/article",
      signImageSrc,
    });
    expect(out).toContain("/api/img?u=");
    expect(out).toContain(
      encodeURIComponent("https://magazine.example/photos/a.jpg"),
    );
    expect(out).not.toContain('src="/photos/a.jpg"');
  });

  it("laisse les images data:image inline intactes", () => {
    const dataUri = "data:image/png;base64,iVBORw0KGgo=";
    const out = sanitizeHtml(`<img src="${dataUri}" alt="" />`, {
      signImageSrc,
    });
    expect(out).toContain(dataUri);
    expect(out).not.toContain("/api/img");
  });

  it("retire iframe et neutralise une tentative d'évasion de body", () => {
    const out = sanitizeHtml(
      `<p>ok</p></body></html><iframe src="https://evil"></iframe><script>e()</script>`,
      { signImageSrc },
    );
    expect(out).toContain("<p>ok</p>");
    expect(out).not.toContain("<iframe");
    expect(out).not.toContain("<script");
  });

  it("préserve le contenu structurel courant d'un article", () => {
    const out = sanitizeHtml(
      "<h2>Titre</h2><p>Para <strong>gras</strong></p><ul><li>a</li><li>b</li></ul><blockquote>cit</blockquote>",
      { signImageSrc },
    );
    expect(out).toContain("<h2>Titre</h2>");
    expect(out).toContain("<strong>gras</strong>");
    expect(out).toContain("<li>a</li>");
    expect(out).toContain("<blockquote>cit</blockquote>");
  });

  it("ouvre les liens conservés dans un nouvel onglet en sécurité", () => {
    const out = sanitizeHtml(`<a href="https://exemple.org/page">lien</a>`, {
      signImageSrc,
    });
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
  });
});
