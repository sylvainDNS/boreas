import createDOMPurify, { type DOMPurify } from "dompurify";
import { DOMParser as LinkeDOMParser, parseHTML } from "linkedom";

export interface SanitizeOptions {
  /** URL de l'article : base de résolution des `src`/`href` relatifs. */
  baseUrl?: string;
  /**
   * Transforme une URL d'image absolue en URL servie (proxy signé, ADR 0009).
   * Appelée pour chaque `<img src>` http(s) après résolution.
   */
  signImageSrc: (absoluteSrc: string) => string;
}

/** Balises conservées : HTML d'article courant, sans média actif ni styles. */
const ALLOWED_TAGS = [
  "p",
  "br",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "a",
  "img",
  "iframe",
  "figure",
  "figcaption",
  "blockquote",
  "q",
  "cite",
  "pre",
  "code",
  "em",
  "strong",
  "b",
  "i",
  "u",
  "s",
  "sub",
  "sup",
  "mark",
  "small",
  "span",
  "div",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "caption",
  "col",
  "colgroup",
];

/**
 * Attributs conservés ; `target`/`rel` sont posés par le hook après coup.
 * `width`/`height`/`allowfullscreen`/`allow`/`frameborder`/`loading` servent
 * surtout au rendu des `<iframe>` vidéo (l'allowlist est globale, c'est la seule
 * voie : ces attributs sont déjà retirés quand le hook s'exécute). `srcdoc` reste
 * volontairement absent (exécution de HTML inline dans l'iframe).
 */
const ALLOWED_ATTR = [
  "href",
  "src",
  "alt",
  "title",
  "colspan",
  "rowspan",
  "width",
  "height",
  "allowfullscreen",
  "allow",
  "frameborder",
  "loading",
];

/** Surface d'élément minimale utilisée par le hook (linkedom fournit l'impl). */
interface ElementLike {
  tagName?: string;
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  remove(): void;
}

/**
 * Hôtes d'iframe vidéo de confiance (ADR 0007). Tout `<iframe>` dont le `src`
 * ne pointe pas vers l'un d'eux (en https) est retiré : un iframe arbitraire
 * ouvrirait clickjacking / exfiltration, et aucune CSP ne couvre le SPA.
 */
const ALLOWED_IFRAME_HOSTS = [
  "youtube-nocookie.com",
  "youtube.com",
  "player.vimeo.com",
];

/** Constantes NodeFilter (linkedom ne les expose pas, DOMPurify les attend). */
const NODE_FILTER = {
  SHOW_ALL: 0xffffffff,
  SHOW_ELEMENT: 1,
  SHOW_TEXT: 4,
  SHOW_CDATA_SECTION: 8,
  SHOW_PROCESSING_INSTRUCTION: 64,
  SHOW_COMMENT: 128,
};

/**
 * Adapte un DOM `linkedom` à ce que DOMPurify 3 attend d'un `window` :
 * - linkedom **n'emballe pas** les fragments dans `<body>` (contrairement aux
 *   navigateurs) → un DOMParser dédié enveloppe l'entrée dans un document
 *   complet, pour que tout le contenu atterrisse bien dans `body` ;
 * - `document.implementation.createHTMLDocument` et `NodeFilter` manquent → on
 *   les fournit (la gate `isSupported` de DOMPurify les exige).
 *
 * On construit un objet `window` **simple** (et non le proxy renvoyé par
 * `parseHTML`, dont les propriétés ne sont pas surchargeables) pour pouvoir y
 * injecter notre DOMParser. Le shim `implementation` est posé sur **l'instance**
 * de document (pas son prototype) pour ne pas polluer les autres documents
 * linkedom de l'app (ex. ceux de `@boreas/content-extractor`).
 */
function createSanitizer(): DOMPurify {
  const base = parseHTML(
    "<!DOCTYPE html><html><head></head><body></body></html>",
  );

  if (!base.document.implementation) {
    Object.defineProperty(base.document, "implementation", {
      configurable: true,
      get: () => ({
        createHTMLDocument: () =>
          parseHTML("<!DOCTYPE html><html><head></head><body></body></html>")
            .document,
      }),
    });
  }

  class WrappingDOMParser {
    parseFromString(markup: string, type: string) {
      return new LinkeDOMParser().parseFromString(
        `<!DOCTYPE html><html><head></head><body>${markup}</body></html>`,
        // biome-ignore lint/suspicious/noExplicitAny: la signature linkedom diffère de la lib DOM
        type as any,
      );
    }
  }

  const window = {
    document: base.document,
    Element: base.Element,
    Node: base.Node,
    DocumentFragment: base.DocumentFragment,
    HTMLTemplateElement: base.HTMLTemplateElement,
    HTMLFormElement: base.HTMLFormElement,
    NamedNodeMap: base.NamedNodeMap,
    NodeFilter: base.NodeFilter ?? NODE_FILTER,
    DOMParser: WrappingDOMParser,
  };

  // biome-ignore lint/suspicious/noExplicitAny: window linkedom adapté à l'interface DOMPurify
  return createDOMPurify(window as any);
}

/** Singleton : la construction du window linkedom est coûteuse. */
let purifier: DOMPurify | undefined;

/**
 * Pré-déplie chaque `<picture>` en son `<img>` fallback **avant** la passe
 * DOMPurify. `picture`/`source` ne sont pas dans l'allowlist : quand DOMPurify
 * retire le `<picture>`, son `<img>` enfant part avec (le `KEEP_CONTENT` ne
 * rapatrie pas l'élément sur le DOM linkedom) et l'image est perdue (#95).
 *
 * En dépliant ici, l'`<img>` fallback remonte à la place du `<picture>` et
 * traverse ensuite le pipeline normal (résolution `baseUrl` + proxy signé +
 * retrait du `srcset` par le hook `img`). Les `<source srcset>` sont écartés :
 * le proxy ne sert qu'une URL.
 *
 * Garde-fou : on ne paie le coût d'un parse linkedom que si un `<picture>` est
 * présent. Un `<picture>` sans `<img>` fallback est retiré (pas de
 * reconstruction depuis `srcset`).
 */
function unwrapPictures(html: string): string {
  if (!/<picture[\s>]/i.test(html)) return html;

  const { document } = parseHTML(
    `<!DOCTYPE html><html><head></head><body>${html}</body></html>`,
  );
  for (const picture of document.querySelectorAll("picture")) {
    const img = picture.querySelector("img");
    if (img) {
      picture.replaceWith(img);
    } else {
      picture.remove();
    }
  }
  return document.body.innerHTML;
}

/** Document linkedom (createElement, querySelectorAll…) tel que renvoyé par `parseHTML`. */
type LinkedomDocument = ReturnType<typeof parseHTML>["document"];

/** Élément linkedom (le package n'inclut pas la lib DOM : pas de `Node` global). */
type LinkedomElement = ReturnType<LinkedomDocument["createElement"]>;

/**
 * Reconstructeur d'embed Substack : transforme les `data-attrs` (JSON non fiable)
 * d'un `<div data-component-name="…ToDOM">` en un nœud rendu, ou `null` si non
 * reconstructible (champs manquants/invalides).
 */
type EmbedReconstructor = (
  attrs: Record<string, unknown>,
  document: LinkedomDocument,
) => LinkedomElement | null;

/**
 * Embeds Substack reconstruits avant sanitization (#96). Tracer : Instagram.
 * Étendre ce registre (`TwitterToDOM`, etc.) pour couvrir d'autres `…ToDOM`.
 */
const SUBSTACK_EMBEDS: Record<string, EmbedReconstructor> = {
  // `InstagramToDOM` : média réhébergé par Substack dans `thumbnail_url`
  // (proxifiable `/api/img`, ADR 0009), enveloppé d'un lien vers le post.
  InstagramToDOM: (attrs, document) => {
    const id = attrs.instagram_id;
    const thumb = attrs.thumbnail_url;
    if (typeof id !== "string" || !/^[\w-]+$/.test(id)) return null;
    if (typeof thumb !== "string" || !isHttpUrl(thumb)) return null;

    const title = typeof attrs.title === "string" ? attrs.title : "";
    const author =
      typeof attrs.author_name === "string" ? attrs.author_name : "";

    const a = document.createElement("a");
    a.setAttribute("href", `https://www.instagram.com/p/${id}/`);
    const img = document.createElement("img");
    img.setAttribute("src", thumb);
    const alt = title || author;
    if (alt) img.setAttribute("alt", alt);
    if (title) img.setAttribute("title", title);
    a.appendChild(img);
    return a;
  },

  // `Twitter2ToDOM` (X) : le tweet n'est que dans `data-attrs` (texte, auteur,
  // lien, photos réhébergées Substack). On régénère une carte avec des balises de
  // l'allowlist uniquement (les `class` seraient retirées par DOMPurify) ; le hook
  // `img` proxifie les photos, le hook `a` pose `target`/`rel`.
  Twitter2ToDOM: (attrs, document) => {
    const url = attrs.url;
    if (typeof url !== "string" || !isHttpUrl(url)) return null;

    const text = typeof attrs.full_text === "string" ? attrs.full_text : "";
    const name = typeof attrs.name === "string" ? attrs.name : "";
    const username = typeof attrs.username === "string" ? attrs.username : "";

    const card = document.createElement("blockquote");
    if (text) {
      const p = document.createElement("p");
      p.appendChild(document.createTextNode(text));
      card.appendChild(p);
    }
    if (name || username) {
      const byline = document.createElement("p");
      const label = username ? `${name} (@${username})`.trim() : name;
      byline.appendChild(document.createTextNode(`— ${label}`));
      card.appendChild(byline);
    }
    // Photos jointes (réhébergées Substack → proxifiables /api/img).
    if (Array.isArray(attrs.photos)) {
      for (const photo of attrs.photos) {
        const p = photo as Record<string, unknown> | null;
        const imgUrl = p?.img_url;
        if (typeof imgUrl !== "string" || !isHttpUrl(imgUrl)) continue;
        const linkUrl = p?.link_url;
        const a = document.createElement("a");
        a.setAttribute(
          "href",
          typeof linkUrl === "string" && isHttpUrl(linkUrl) ? linkUrl : url,
        );
        const img = document.createElement("img");
        img.setAttribute("src", imgUrl);
        a.appendChild(img);
        card.appendChild(a);
      }
    }
    const source = document.createElement("a");
    source.setAttribute("href", url);
    source.appendChild(document.createTextNode("Voir sur X"));
    card.appendChild(source);
    return card;
  },
};

/**
 * Reconstruit les embeds Substack `…ToDOM` **avant** la passe DOMPurify (#96).
 * Substack enveloppe chaque embed dans un `<div data-component-name="…ToDOM"
 * data-attrs="{json}">`. Deux cas :
 * - **wrapper vide** (le média n'est que dans `data-attrs`, hydraté côté client :
 *   Instagram, Twitter/X) → on lit le JSON et on régénère un nœud rendu
 *   (Instagram → `<a><img>`, Twitter → carte `<blockquote>`), qui traverse ensuite
 *   le pipeline (hook `img` = proxy du `src`, hook `a` = `target`/`rel`) ;
 * - **wrapper portant déjà le rendu serveur** (Youtube2ToDOM → `<iframe>`,
 *   Image2ToDOM → `<picture>`) → aucun reconstructeur, mais on **déplie** le div
 *   (on le remplace par ses enfants) au lieu de le supprimer : sinon l'iframe/le
 *   picture embarqués seraient jetés avant que l'allowlist d'hôtes iframe (#94) et
 *   le dépliage `<picture>` (#95) ne les traitent (#97/régression observée sur
 *   datenow-75). Un wrapper réellement vide se déplie en rien = retiré.
 *
 * Les `div[data-component-name]` **ne finissant pas** par `ToDOM` (autres composants
 * Substack porteurs de contenu) sont laissés tels quels — DOMPurify retirera seulement
 * leurs `data-*` (hors allowlist).
 *
 * Garde-fou : parse linkedom seulement si un `data-component-name` est présent.
 * Les nœuds reconstruits sont construits via `createElement`/`setAttribute`/
 * `createTextNode` (jamais d'interpolation HTML) : les valeurs viennent d'un JSON
 * non fiable. Le dépliage n'introduit aucun contenu neuf : tout repasse par DOMPurify.
 */
function reconstructSubstackEmbeds(html: string): string {
  if (!/data-component-name/i.test(html)) return html;

  const { document } = parseHTML(
    `<!DOCTYPE html><html><head></head><body>${html}</body></html>`,
  );
  for (const div of document.querySelectorAll("div[data-component-name]")) {
    const name = div.getAttribute("data-component-name") ?? "";
    if (!name.endsWith("ToDOM")) continue;

    let node: LinkedomElement | null = null;
    const reconstructor = SUBSTACK_EMBEDS[name];
    if (reconstructor) {
      try {
        const attrs = JSON.parse(div.getAttribute("data-attrs") ?? "null");
        if (attrs && typeof attrs === "object") {
          node = reconstructor(attrs as Record<string, unknown>, document);
        }
      } catch {
        // data-attrs JSON invalide → non reconstructible (node reste null).
      }
    }

    if (node) {
      // Placeholder vide reconstruit (Instagram, Twitter) → on substitue le rendu.
      div.replaceWith(node);
    } else {
      // Pas de reconstruction : on déplie le wrapper pour préserver le rendu
      // serveur embarqué (iframe, picture). `childNodes` est live → matérialiser
      // avant de remplacer. Un wrapper vide se déplie en rien (= retrait).
      div.replaceWith(...Array.from(div.childNodes));
    }
  }
  return document.body.innerHTML;
}

/**
 * Sanitize du HTML d'article non fiable côté serveur (ADR 0007), sur un DOM
 * `linkedom`. DOMPurify retire `<script>`/`<style>`, les handlers `on*` et les
 * schémas dangereux (`javascript:`…). En amont, chaque `<picture>` est déplié
 * en son `<img>` fallback (cf. `unwrapPictures`) et les embeds Substack `…ToDOM`
 * sont reconstruits depuis leurs `data-attrs` (cf. `reconstructSubstackEmbeds`).
 * Un hook réécrit en plus :
 * - les `src` d'images http(s) vers le proxy signé (ADR 0009) ;
 * - les liens en `target="_blank"` + `rel="noopener noreferrer"` ;
 * - retire les `<iframe>` hors de l'allowlist d'hôtes vidéo (`ALLOWED_IFRAME_HOSTS`).
 *
 * Les hooks sont réinstallés à chaque appel (capture de `opts`). `sanitize`
 * étant synchrone de bout en bout, aucun entrelacement n'est possible.
 */
export function sanitizeHtml(html: string, opts: SanitizeOptions): string {
  if (!purifier) {
    purifier = createSanitizer();
  }

  // Les commentaires HTML font planter linkedom 0.18.12 quand DOMPurify 3.4.8
  // les force-remove (Comment.remove() accède à `this[END][NEXT]` = undefined).
  // On les retire en amont : DOMPurify les supprimerait de toute façon, donc
  // c'est sans effet sur la sortie — mais ça évite le crash qui, propagé jusqu'à
  // `extractAndStore`, vidait le contenu des articles concernés (#6/#7).
  // Le `(?:-->|$)` couvre aussi un commentaire non fermé (flux mal formé, repli
  // HTML brut de `extractArticle`) : sans fin, le parseur l'étend jusqu'à l'EOF,
  // on fait pareil — sinon le nœud commentaire subsiste et le crash revient.
  //
  // Même famille de bug pour les `<svg>` inline : DOMPurify sur linkedom, en les
  // retirant (svg hors allowlist), **vide tout le sous-arbre voisin** au lieu du
  // seul svg — sur Substack, les contrôles zoom `<button><svg>…</svg></button>`
  // d'un `Image2ToDOM` emportaient ainsi l'image de l'article. On retire les svg
  // en amont : jamais conservés en sortie de toute façon, donc sans perte, mais
  // sans l'effacement collatéral.
  const input = reconstructSubstackEmbeds(
    unwrapPictures(
      html
        .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
        .replace(/<svg[\s\S]*?<\/svg>/gi, ""),
    ),
  );

  // DOMPurify sur linkedom 0.18.12 plante (Comment.remove, même famille que
  // #6/#7) sur une entrée vide. La reconstruction d'embeds peut vider le contenu
  // (article réduit à un placeholder non reconstructible) → on court-circuite.
  if (input.trim() === "") return "";

  purifier.removeAllHooks();
  purifier.addHook("afterSanitizeAttributes", (node) => {
    const el = node as unknown as ElementLike;
    const tag = el.tagName?.toUpperCase();

    if (tag === "IMG" && el.hasAttribute("src")) {
      const raw = el.getAttribute("src") ?? "";
      if (!raw.startsWith("data:image/")) {
        const absolute = resolveUrl(raw, opts.baseUrl);
        if (absolute) {
          el.setAttribute("src", opts.signImageSrc(absolute));
        } else {
          el.removeAttribute("src");
        }
      }
      // srcset non géré en v1 (le proxy ne sert qu'une URL) : on le retire.
      el.removeAttribute("srcset");
    }

    if (tag === "A" && el.hasAttribute("href")) {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    }

    // iframe conservé seulement si son src est un embed https d'un hôte vidéo
    // de confiance ; sinon retiré en entier (pas juste le src).
    if (
      tag === "IFRAME" &&
      !isAllowedVideoIframe(el.getAttribute("src") ?? "")
    ) {
      el.remove();
    }
  });

  const clean = purifier.sanitize(input, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    // Conserve le contenu textuel des balises retirées (ex. <span> non listé).
    KEEP_CONTENT: true,
    // Sans ça, DOMPurify laisse passer **tous** les `data-*` (défaut `true`),
    // court-circuitant l'allowlist stricte : les `data-attrs` des placeholders
    // Substack pollueraient la sortie (#96).
    ALLOW_DATA_ATTR: false,
  });

  return typeof clean === "string" ? clean : String(clean);
}

/**
 * Résout une URL (potentiellement relative) contre la base de l'article.
 * Renvoie `null` si l'URL est relative sans base, ou non parsable.
 */
function resolveUrl(src: string, baseUrl?: string): string | null {
  try {
    return baseUrl ? new URL(src, baseUrl).href : new URL(src).href;
  } catch {
    return null;
  }
}

/** Vrai si `value` est une URL http(s) absolue (valide un `thumbnail_url` reconstruit). */
function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Vrai si `src` est un embed **https absolu** sur un hôte de `ALLOWED_IFRAME_HOSTS`.
 * Le `endsWith("." + h)` accepte les sous-domaines (`www.youtube.com`) sans laisser
 * passer un look-alike (`evil-youtube.com` n'a pas le point séparateur).
 */
function isAllowedVideoIframe(src: string): boolean {
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return ALLOWED_IFRAME_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}
