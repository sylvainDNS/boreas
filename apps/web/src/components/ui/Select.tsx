import type { SelectHTMLAttributes } from "react";

/**
 * `<select>` natif stylé aux tokens du design system (cohérent avec `Button` :
 * hauteur ≥ 44px, focus accessible). Natif pour rester testable en jsdom et
 * gérer le clavier sans code maison.
 */
export function Select({
  className = "",
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`min-h-11 rounded-card border border-border bg-surface px-3 text-sm text-text transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 disabled:opacity-50 ${className}`}
      {...props}
    />
  );
}
