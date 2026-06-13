import {
  Children,
  isValidElement,
  type ReactNode,
  useRef,
  useState,
} from "react";

/**
 * Carte « fenêtre » d'un bloc de code, montée par `ArticleContent` à la place de
 * chaque `<pre>` (mapping rehype-react). Affiche le chrome `●●●`, le langage
 * auto-détecté par `rehype-highlight` (classe `language-*` posée sur le `<code>`
 * enfant) et un bouton « Copier ». La coloration des tokens est faite en amont par
 * `rehype-highlight` (classes `.hljs-*`) ; ici on ne fait que l'habillage.
 */

/** Noms highlight.js → libellés présentables (repli : le nom brut). */
const PRETTY_LANG: Record<string, string> = {
  typescript: "TypeScript",
  javascript: "JavaScript",
  json: "JSON",
  bash: "Bash",
  shell: "Shell",
  python: "Python",
  css: "CSS",
  xml: "HTML",
  html: "HTML",
  sql: "SQL",
  yaml: "YAML",
  go: "Go",
  rust: "Rust",
};

/** Extrait le langage depuis la classe `language-*` du `<code>` enfant. */
function detectLang(children: ReactNode): string | null {
  for (const child of Children.toArray(children)) {
    if (!isValidElement(child)) continue;
    const className = (child.props as { className?: string }).className ?? "";
    const match = /language-([\w-]+)/.exec(className);
    if (match) return match[1] ?? null;
  }
  return null;
}

export function CodeBlock({ children }: { children?: ReactNode }) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const lang = detectLang(children);

  function copy() {
    // `navigator.clipboard` est absent hors contexte sécurisé (HTTP simple, iframe sans
    // permission) : y accéder lèverait une TypeError synchrone, non couverte par `.catch`.
    if (!navigator.clipboard) return;
    const text = preRef.current?.textContent ?? "";
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        // Presse-papiers indisponible (contexte non sécurisé, permission refusée) :
        // on ignore silencieusement, le code reste sélectionnable à la main.
      });
  }

  return (
    <div className="code-card">
      <div className="code-card__bar">
        <span className="code-card__dots" aria-hidden="true">
          ●●●
        </span>
        {lang && (
          <span className="code-card__lang">{PRETTY_LANG[lang] ?? lang}</span>
        )}
        <button type="button" className="code-card__copy" onClick={copy}>
          {copied ? "Copié ✓" : "Copier"}
        </button>
      </div>
      <pre ref={preRef}>{children}</pre>
    </div>
  );
}
