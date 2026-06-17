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

  it("ne plante pas sur les commentaires HTML et les retire", () => {
    // Régression : un commentaire HTML faisait planter DOMPurify 3.4.8 sur le
    // DOM linkedom (Comment.remove() → this[END][NEXT] undefined), ce qui vidait
    // le contenu des articles dont le flux en contient (ex. This Week In React).
    const out = sanitizeHtml("<p>avant</p><!-- pub --><p>après</p>", {
      signImageSrc,
    });
    expect(out).toContain("avant");
    expect(out).toContain("après");
    expect(out).not.toContain("<!--");
  });

  it("ne plante pas sur un commentaire HTML non fermé", () => {
    // Repli HTML brut d'un flux mal formé : sans `-->`, le commentaire court
    // jusqu'à l'EOF — on le retire en entier comme le ferait le parseur.
    const out = sanitizeHtml("<p>avant</p><!-- commentaire sans fin", {
      signImageSrc,
    });
    expect(out).toContain("avant");
    expect(out).not.toContain("<!--");
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

  it("retire un iframe d'hôte non autorisé et neutralise une évasion de body", () => {
    const out = sanitizeHtml(
      `<p>ok</p></body></html><iframe src="https://evil.com/embed"></iframe><script>e()</script>`,
      { signImageSrc },
    );
    expect(out).toContain("<p>ok</p>");
    expect(out).not.toContain("<iframe");
    expect(out).not.toContain("<script");
  });

  it("conserve un iframe YouTube (nocookie) avec ses attributs de rendu", () => {
    const out = sanitizeHtml(
      `<iframe src="https://www.youtube-nocookie.com/embed/abc123" width="560" height="315" allowfullscreen allow="encrypted-media; picture-in-picture"></iframe>`,
      { signImageSrc },
    );
    expect(out).toContain("<iframe");
    expect(out).toContain("https://www.youtube-nocookie.com/embed/abc123");
    expect(out).toContain("allowfullscreen");
    expect(out).toContain("allow=");
    expect(out).toContain('width="560"');
  });

  it("conserve les iframes youtube.com et player.vimeo.com", () => {
    const yt = sanitizeHtml(
      `<iframe src="https://www.youtube.com/embed/xyz"></iframe>`,
      { signImageSrc },
    );
    expect(yt).toContain("https://www.youtube.com/embed/xyz");
    const vimeo = sanitizeHtml(
      `<iframe src="https://player.vimeo.com/video/12345"></iframe>`,
      { signImageSrc },
    );
    expect(vimeo).toContain("https://player.vimeo.com/video/12345");
  });

  it("retire un iframe look-alike (evil-youtube.com)", () => {
    const out = sanitizeHtml(
      `<iframe src="https://evil-youtube.com/embed/abc"></iframe>`,
      { signImageSrc },
    );
    expect(out).not.toContain("<iframe");
    expect(out).not.toContain("evil-youtube.com");
  });

  it("retire un iframe d'hôte autorisé mais en http (durci https)", () => {
    const out = sanitizeHtml(
      `<iframe src="http://www.youtube.com/embed/abc"></iframe>`,
      { signImageSrc },
    );
    expect(out).not.toContain("<iframe");
  });

  it("retire un iframe au src relatif ou non absolu", () => {
    const out = sanitizeHtml(`<iframe src="/embed/abc"></iframe>`, {
      baseUrl: "https://magazine.example/article",
      signImageSrc,
    });
    expect(out).not.toContain("<iframe");
  });

  it("conserve un iframe autorisé en retirant onload et srcdoc", () => {
    const out = sanitizeHtml(
      `<iframe src="https://player.vimeo.com/video/42" onload="steal()" srcdoc="<script>x()</script>"></iframe>`,
      { signImageSrc },
    );
    expect(out).toContain("https://player.vimeo.com/video/42");
    expect(out).not.toContain("onload");
    expect(out).not.toContain("srcdoc");
    expect(out).not.toContain("steal");
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

  it("préserve l'<img> fallback d'un <picture> et le signe, sans <source>/srcset", () => {
    // Substack livre l'image en <picture><source srcset><img></picture> ; sans
    // dépliage, DOMPurify retire le <picture> et son <img> part avec (#95).
    const out = sanitizeHtml(
      `<picture><source type="image/webp" srcset="https://src.example/x.webp" /><img src="https://src.example/x.jpg" alt="A" /></picture>`,
      { signImageSrc },
    );
    expect(out).toContain("/api/img?u=");
    expect(out).toContain(encodeURIComponent("https://src.example/x.jpg"));
    expect(out).toContain('alt="A"');
    expect(out).not.toContain("<picture");
    expect(out).not.toContain("<source");
    expect(out).not.toContain("srcset");
  });

  it("résout le src relatif d'un <img> en <picture> contre baseUrl", () => {
    const out = sanitizeHtml(
      `<picture><source srcset="/photos/a.webp" /><img src="/photos/a.jpg" alt="A" /></picture>`,
      { baseUrl: "https://magazine.example/article", signImageSrc },
    );
    expect(out).toContain(
      encodeURIComponent("https://magazine.example/photos/a.jpg"),
    );
    expect(out).not.toContain("<picture");
    expect(out).not.toContain("<source");
  });

  it("retire un <picture> sans <img> fallback", () => {
    // Pas de reconstruction depuis srcset : le proxy ne sert qu'une URL (#95).
    const out = sanitizeHtml(
      `<p>avant</p><picture><source srcset="https://src.example/x.webp" /></picture><p>après</p>`,
      { signImageSrc },
    );
    expect(out).toContain("avant");
    expect(out).toContain("après");
    expect(out).not.toContain("<picture");
    expect(out).not.toContain("<source");
    expect(out).not.toContain("srcset");
  });

  it("ne plante pas et renvoie une chaîne vide sur une entrée vide", () => {
    // DOMPurify sur linkedom plante sur entrée vide ; un article réduit à un
    // embed non reconstructible se vide après la pré-passe (#96).
    expect(sanitizeHtml("", { signImageSrc })).toBe("");
    expect(sanitizeHtml("   \n  ", { signImageSrc })).toBe("");
  });

  it("reconstruit un embed Instagram (InstagramToDOM) en lien + image proxifiée", () => {
    // data-attrs réaliste observé sur datenow-75 (#96). Quotes JSON via attribut
    // en simple-quote pour rester du HTML valide.
    const thumb =
      "https://substack-post-media.s3.amazonaws.com/public/images/__ss-rehost__IG-meta-DVwle3zjQXZ.jpg";
    const out = sanitizeHtml(
      `<div data-component-name="InstagramToDOM" data-attrs='{"instagram_id":"DVwle3zjQXZ","author_name":"@devgirl___","thumbnail_url":"${thumb}","title":"/dev/girl on Instagram"}'></div>`,
      { signImageSrc },
    );
    expect(out).toContain('href="https://www.instagram.com/p/DVwle3zjQXZ/"');
    expect(out).toContain("/api/img?u=");
    expect(out).toContain(encodeURIComponent(thumb));
    expect(out).toContain('title="/dev/girl on Instagram"');
    expect(out).toContain('alt="/dev/girl on Instagram"');
    expect(out).toContain('target="_blank"');
    expect(out).not.toContain("data-component-name");
    expect(out).not.toContain("data-attrs");
  });

  it("retire un InstagramToDOM au data-attrs JSON invalide", () => {
    const out = sanitizeHtml(
      `<p>ok</p><div data-component-name="InstagramToDOM" data-attrs="{pas du json}"></div>`,
      { signImageSrc },
    );
    expect(out).toContain("<p>ok</p>");
    expect(out).not.toContain("<a");
    expect(out).not.toContain("data-component-name");
  });

  it("retire un InstagramToDOM sans thumbnail_url (non reconstructible)", () => {
    const out = sanitizeHtml(
      `<div data-component-name="InstagramToDOM" data-attrs='{"instagram_id":"abc"}'></div>`,
      { signImageSrc },
    );
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<a");
    expect(out).not.toContain("data-component-name");
  });

  it("retire un …ToDOM non géré même porteur de contenu", () => {
    const out = sanitizeHtml(
      `<p>avant</p><div data-component-name="TwitterToDOM" data-attrs="{}">tweet brut</div><p>après</p>`,
      { signImageSrc },
    );
    expect(out).toContain("avant");
    expect(out).toContain("après");
    expect(out).not.toContain("tweet brut");
    expect(out).not.toContain("data-component-name");
  });

  it("laisse un div[data-component-name] non-ToDOM, en retirant ses data-*", () => {
    const out = sanitizeHtml(
      `<div data-component-name="Pullquote" data-attrs="{}"><strong>contenu</strong></div>`,
      { signImageSrc },
    );
    expect(out).toContain("<strong>contenu</strong>");
    expect(out).not.toContain("data-component-name");
    expect(out).not.toContain("data-attrs");
  });

  it("ouvre les liens conservés dans un nouvel onglet en sécurité", () => {
    const out = sanitizeHtml(`<a href="https://exemple.org/page">lien</a>`, {
      signImageSrc,
    });
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
  });
});
