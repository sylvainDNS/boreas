import { type ReactNode, useEffect, useRef, useState } from "react";

/** Classe partagée des entrées de menu (boutons pleine largeur). Les entrées
 *  `disabled` (ops online-only hors-ligne, #81) sont atténuées et non cliquables. */
export const menuItemClass =
  "flex w-full items-center gap-2 rounded-card px-3 py-2 text-left text-sm text-text transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent";

/** En-tête de groupe à l'intérieur d'un menu (libellé non cliquable). */
export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <p className="px-3 pt-2 pb-1 font-semibold text-[0.65rem] text-muted uppercase tracking-wide">
      {children}
    </p>
  );
}

/**
 * Menu contextuel « ⋯ » d'une ligne de sidebar (#13). Popover maison (cohérent
 * avec `Dialog`) : ferme sur Échap, sur clic extérieur et après sélection (le
 * `close` passé au render des enfants). Le bouton stoppe la propagation pour ne
 * pas déclencher la navigation du `Link` voisin. `children` est une fonction qui
 * reçoit `close` pour que chaque entrée referme le menu après son action.
 */
export function RowMenu({
  label,
  triggerClassName = "",
  children,
}: {
  label: string;
  /** Classes additionnelles du seul bouton « ⋯ » (ex. opacité au survol). Le
   * popover reste toujours opaque, peu importe le survol de la ligne. */
  triggerClassName?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className={`grid size-7 place-items-center rounded-card text-muted leading-none transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 ${triggerClassName}`}
      >
        ⋯
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 min-w-48 rounded-card border border-border bg-surface p-1 shadow-pop"
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
