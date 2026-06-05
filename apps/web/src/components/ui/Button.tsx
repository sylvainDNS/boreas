import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "outline" | "ghost";

const BASE =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-card px-4 font-medium text-sm transition-colors focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 disabled:opacity-50";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:bg-accent-hover",
  outline: "border border-border bg-surface text-text hover:bg-surface-2",
  ghost: "text-text hover:bg-surface-2",
};

/**
 * Classes du design system pour un élément cliquable. Source unique partagée
 * par `Button` (`<button>`) et par les liens stylés en bouton (ex. « Original »
 * dans le lecteur, qui doit être un `<a>`).
 */
export function buttonClasses(
  variant: Variant = "primary",
  className = "",
): string {
  return `${BASE} ${VARIANTS[variant]} ${className}`;
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

/** Bouton du design system. Cible tactile ≥ 44px (direction « Moderne carte »). */
export function Button({
  variant = "primary",
  className = "",
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={buttonClasses(variant, className)}
      {...props}
    />
  );
}
