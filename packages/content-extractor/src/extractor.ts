import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

/**
 * Contenu d'article extrait. `content` est du HTML (non encore sanitizé : la
 * sanitization est une étape séparée, ADR 0007) et n'est jamais vide — à défaut
 * d'extraction exploitable, on retombe sur le HTML brut fourni en entrée.
 */
export interface ExtractedArticle {
  title: string | null;
  /** HTML du contenu principal, garanti non vide. */
  content: string;
  byline: string | null;
  excerpt: string | null;
}

/**
 * Extrait le contenu principal d'un document HTML façon Readability, sur un DOM
 * `linkedom` (runtime-agnostique, tourne dans le Worker). `url` sert de base de
 * résolution des liens/images relatifs.
 *
 * Réécriture de l'entrée : la chaîne d'ingestion (#6/#10) ne dispose souvent que
 * du `content:encoded` du flux — déjà proche du corps de l'article. Readability
 * y enlève le chrome résiduel quand il y en a ; quand il ne trouve rien
 * d'exploitable (fragment trop court, parse en échec), on **conserve le HTML
 * brut** plutôt que de perdre le contenu.
 */
export function extractArticle(rawHtml: string, url: string): ExtractedArticle {
  const fallback: ExtractedArticle = {
    title: null,
    content: rawHtml,
    byline: null,
    excerpt: null,
  };

  try {
    const { document } = parseHTML(rawHtml);
    // <base href> : Readability résout les URLs relatives contre baseURI.
    if (url) {
      const head = document.querySelector("head") ?? document.documentElement;
      const base =
        document.querySelector("base") ?? document.createElement("base");
      base.setAttribute("href", url);
      if (!base.parentNode && head) head.insertBefore(base, head.firstChild);
    }

    const parsed = new Readability(document).parse();
    if (!parsed?.content || parsed.content.trim() === "") {
      return fallback;
    }
    return {
      title: parsed.title ?? null,
      content: parsed.content,
      byline: parsed.byline ?? null,
      excerpt: parsed.excerpt ?? null,
    };
  } catch {
    return fallback;
  }
}
