import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import type { RowMenuPosition } from "./useRowMenu";

/** Classe partagée des entrées de menu (boutons pleine largeur). Les entrées
 *  `disabled` (ops online-only hors-ligne, #81) sont atténuées et non cliquables. */
export const menuItemClass =
  "flex w-full items-center gap-2 rounded-card px-3 py-2 text-left text-sm text-text transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent";

/** Classe du bouton déclencheur « ⋯ » d'une ligne (#114). Invisible au repos,
 *  révélé au focus **clavier** uniquement (ligne via `group-has-[:focus-visible]`,
 *  ou bouton via `focus-visible`). On n'utilise pas `group-focus-within`, qui
 *  réagit aussi au focus **souris** du `Link` : cliquer un flux pour le lire
 *  rouvrirait sinon le « ⋯ » sur la ligne active, alors que le kebab visible est
 *  retiré (décision figée #114). Partagée entre `FeedRow` et `FolderTree`. */
export const rowMenuTriggerClass =
  "grid size-7 shrink-0 place-items-center rounded-card text-muted leading-none opacity-0 transition-opacity hover:bg-surface-2 hover:text-text focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 group-has-[:focus-visible]:opacity-100";

/** Marge minimale entre le popover et le bord du viewport (clamp anti-débordement). */
const VIEWPORT_MARGIN = 8;

/**
 * Popover du menu contextuel d'une ligne (#114, ADR 0019). **Contrôlé** : son
 * ouverture et sa position sont pilotées par `useRowMenu` (clic droit / clavier),
 * il n'a plus de bouton kebab propre. Ancré en `position: fixed` aux coordonnées
 * fournies, recalées pour ne pas déborder du viewport. Cohérent avec `Dialog`
 * (bordure, `shadow-pop`). `children` reçoit `close` pour refermer après action ;
 * la fermeture sur Échap / clic extérieur est gérée par `useRowMenu`. Le
 * `pointerdown` interne est stoppé pour ne pas déclencher cette fermeture.
 */
export function RowMenu({
  label,
  position,
  onClose,
  children,
}: {
  label: string;
  position: RowMenuPosition;
  onClose: () => void;
  children: (close: () => void) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState(position);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const x = Math.min(position.x, window.innerWidth - width - VIEWPORT_MARGIN);
    const y = Math.min(
      position.y,
      window.innerHeight - height - VIEWPORT_MARGIN,
    );
    setCoords({
      x: Math.max(VIEWPORT_MARGIN, x),
      y: Math.max(VIEWPORT_MARGIN, y),
    });
  }, [position]);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      style={{ left: coords.x, top: coords.y }}
      // Le pointerdown interne ne doit pas remonter à la fenêtre (qui referme).
      onPointerDown={(e) => e.stopPropagation()}
      className="fixed z-50 min-w-48 rounded-card border border-border bg-surface p-1 shadow-pop"
    >
      {children(onClose)}
    </div>
  );
}
