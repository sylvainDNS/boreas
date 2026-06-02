import type { ReactNode } from "react";

/** Pastille de compteur (non-lus). Discrète si zéro. */
export function CountBadge({
  count,
  className = "",
}: {
  count: number;
  className?: string;
}) {
  if (count <= 0) return null;
  return (
    <span
      className={`rounded-full bg-surface-2 px-2 py-0.5 text-muted text-xs tabular-nums ${className}`}
    >
      {count}
    </span>
  );
}

/** Étiquette de source (nom du Feed). */
export function FeedChip({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full bg-surface-2 px-2 py-0.5 font-medium text-muted text-xs">
      {children}
    </span>
  );
}
