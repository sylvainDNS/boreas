import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from "react";
import { useCallback, useEffect, useState } from "react";

/** Coordonnées viewport où ancrer le popover (`position: fixed`). */
export type RowMenuPosition = { x: number; y: number };

/**
 * Ouverture/fermeture d'un menu contextuel de ligne (#114, ADR 0019). Porté par
 * la **ligne**, pas par un bouton kebab : ouverture au **clic droit**
 * (`onContextMenu`, ancré au curseur) et au **clavier** (`Shift+F10` / touche
 * Menu, ou le déclencheur révélé au focus — `triggerProps`, ancré à l'élément).
 * Ferme sur Échap, clic extérieur, scroll et redimensionnement. Le popover
 * (`RowMenu`) stoppe le `pointerdown` interne pour ne pas se refermer sur lui-même.
 */
export function useRowMenu() {
  const [position, setPosition] = useState<RowMenuPosition | null>(null);
  const isOpen = position !== null;
  const close = useCallback(() => setPosition(null), []);

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = () => close();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    // `capture` pour intercepter le scroll de n'importe quel conteneur défilant.
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [isOpen, close]);

  /** Ancre le menu sous le coin haut-gauche d'un élément (clavier / déclencheur). */
  const openFromElement = useCallback((el: Element) => {
    const r = el.getBoundingClientRect();
    setPosition({ x: r.left, y: r.bottom });
  }, []);

  /**
   * Ouverture **programmatique** aux coordonnées viewport fournies (#120, lift
   * tactile : ancré sous le doigt). Même mécanique que `onContextMenu` sans
   * l'événement souris ; le clamp anti-débordement est porté par `RowMenu`.
   */
  const openAt = useCallback((x: number, y: number) => {
    setPosition({ x, y });
  }, []);

  const onContextMenu = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    setPosition({ x: e.clientX, y: e.clientY });
  }, []);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      // Geste a11y standard : touche Menu (`ContextMenu`) ou `Shift+F10`.
      if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
        e.preventDefault();
        openFromElement(e.currentTarget);
      }
    },
    [openFromElement],
  );

  /** À étaler sur le bouton déclencheur révélé au focus clavier. */
  const triggerProps = {
    "aria-haspopup": "menu" as const,
    "aria-expanded": isOpen,
    onClick: (e: ReactMouseEvent) => {
      // Évite la navigation du `Link` voisin et la bascule du menu.
      e.preventDefault();
      e.stopPropagation();
      openFromElement(e.currentTarget);
    },
  };

  return {
    isOpen,
    position,
    close,
    openAt,
    onContextMenu,
    onKeyDown,
    triggerProps,
  };
}
