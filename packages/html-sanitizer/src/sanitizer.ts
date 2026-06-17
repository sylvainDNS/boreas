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
 * Sanitize du HTML d'article non fiable côté serveur (ADR 0007), sur un DOM
 * `linkedom`. DOMPurify retire `<script>`/`<style>`, les handlers `on*` et les
 * schémas dangereux (`javascript:`…). Un hook réécrit en plus :
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
  const input = html.replace(/<!--[\s\S]*?(?:-->|$)/g, "");

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
