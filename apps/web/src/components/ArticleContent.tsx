import { Fragment, type ReactElement, useMemo } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
import rehypeHighlight from "rehype-highlight";
import rehypeParse from "rehype-parse";
import rehypeReact from "rehype-react";
import { unified } from "unified";
import { CodeBlock } from "./CodeBlock";

/**
 * Rend le HTML d'article (déjà sanitizé côté serveur, ADR 0007) en arbre React,
 * en colorant les blocs `pre code` au passage. Transform **déclaratif** au rendu
 * (fonction pure mémoïsée) — pas de `querySelector` impératif en `useEffect`.
 *
 * Pipeline : rehype-parse (fragment) → rehype-highlight (lowlight) → rehype-react.
 * `detect: true` est nécessaire car le sanitizer retire la classe `language-*` :
 * highlight.js auto-détecte donc le langage, restreint au `subset` ci-dessous pour
 * la précision et le poids. Chargé en lazy par `ReaderPane` (code-split).
 */

// Langages testés par l'auto-détection (les plus courants dans nos flux).
const SUBSET = [
  "bash",
  "json",
  "typescript",
  "javascript",
  "python",
  "css",
  "xml",
  "sql",
  "yaml",
  "go",
  "rust",
];

const processor = unified()
  .use(rehypeParse, { fragment: true })
  // `ignoreMissing` : si une classe `language-xxx` inconnue survivait un jour au sanitizer,
  // ne pas lever — laisser le bloc non coloré plutôt que casser le rendu.
  .use(rehypeHighlight, { detect: true, subset: SUBSET, ignoreMissing: true })
  .use(rehypeReact, {
    Fragment,
    jsx,
    jsxs,
    // Chaque <pre> devient une carte de code ; le code inline reste brut (pastille CSS).
    components: { pre: CodeBlock },
  });

export default function ArticleContent({ html }: { html: string }) {
  return useMemo(
    () => processor.processSync(html).result as ReactElement,
    [html],
  );
}
