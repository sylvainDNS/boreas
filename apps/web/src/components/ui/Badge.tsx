import type { ReactNode } from "react";

/**
 * Point de présence « non-lus » sans chiffre (#115), aligné à droite des lignes
 * flux/dossier. Pastille pleine en couleur d'accent du design system ; rien si
 * tout est lu. Le compteur chiffré (`CountBadge`) reste réservé aux vues
 * globales (« Tous les non-lus »).
 */
export function UnreadDot({
  hasUnread,
  className = "",
}: {
  hasUnread: boolean;
  className?: string;
}) {
  if (!hasUnread) return null;
  return (
    <span
      role="img"
      aria-label="non lu"
      className={`size-2 shrink-0 rounded-full bg-accent ${className}`}
    />
  );
}

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

/**
 * Badge « flux en erreur » (#11) : pastille ⚠ en couleur danger, affichée quand
 * un Feed a dépassé le seuil d'échecs consécutifs. `detail` (code d'erreur brut,
 * ex. `http_404`) enrichit l'info-bulle.
 */
export function ErrorBadge({
  detail,
  className = "",
}: {
  detail?: string | null;
  className?: string;
}) {
  const title = detail ? `Flux en erreur (${detail})` : "Flux en erreur";
  return (
    <span
      role="img"
      title={title}
      aria-label={title}
      className={`text-danger text-xs leading-none ${className}`}
    >
      <span aria-hidden>⚠</span>
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
