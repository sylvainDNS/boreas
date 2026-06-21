import { useDragDropMonitor } from "@dnd-kit/react";
import { useRef, useState } from "react";
import { MOVE_AFTER_LIFT_THRESHOLD } from "./sidebar-model";

/**
 * Geste long-press unifié « style iOS » (#120, ADR 0019), côté **ligne**. Branche
 * le menu contextuel (`useRowMenu`) sur le cycle de vie du drag dnd-kit, validé par
 * le spike #119 : sur tactile, le « drag start » du `PointerSensor` (hold ~250 ms)
 * **est** le lift → on présente le menu ; si le doigt franchit
 * `MOVE_AFTER_LIFT_THRESHOLD`, l'interaction **bascule en drag** (menu refermé, le
 * réordonnancement étant fait par `handleDragEnd` de la Sidebar) ; relâché sur
 * place, le menu reste ouvert pour la sélection.
 *
 * `useDragDropMonitor` fire **globalement** dans le `DragDropProvider` : chaque
 * handler se filtre en tête sur `source.id === sourceId` pour ne réagir qu'au drag
 * de CETTE ligne. Sur souris, aucun lift (desktop = clic droit) ; `liftActive`
 * reste alors faux. Désabonnement automatique au démontage (lignes de dossiers
 * repliés).
 */
export function useLiftMenu({
  sourceId,
  openAt,
  close,
}: {
  /** Identité dnd-kit de la ligne (`feed.id` ou `folder.id`). */
  sourceId: string;
  /** Ouverture programmatique du menu aux coordonnées viewport (de `useRowMenu`). */
  openAt: (x: number, y: number) => void;
  /** Fermeture du menu (de `useRowMenu`). */
  close: () => void;
}): { liftActive: boolean } {
  // Refs de course lues dans move/end sans dépendre d'un re-render entre eux :
  // - `liftActiveRef` : lift tactile en cours pour cette source.
  // - `movedRef` : seuil post-lift franchi (bascule unique vers le drag).
  const liftActiveRef = useRef(false);
  const movedRef = useRef(false);
  // Miroir réactif : pilote le garde JSX du `contextmenu` natif + le style soulevé.
  const [liftActive, setLiftActive] = useState(false);

  useDragDropMonitor({
    onDragStart(event) {
      if (String(event.operation.source?.id) !== sourceId) return;
      movedRef.current = false;
      const activator = event.operation.activatorEvent;
      const isTouch =
        activator instanceof PointerEvent && activator.pointerType !== "mouse";
      if (!isTouch) {
        // Souris : drag direct, pas de menu au lift (desktop = clic droit).
        liftActiveRef.current = false;
        setLiftActive(false);
        return;
      }
      // LIFT : menu ancré sous le doigt + retour haptique best-effort.
      liftActiveRef.current = true;
      setLiftActive(true);
      navigator.vibrate?.(10);
      openAt(activator.clientX, activator.clientY + 12);
    },
    onDragMove(event) {
      if (!liftActiveRef.current || movedRef.current) return;
      if (String(event.operation.source?.id) !== sourceId) return;
      const { x, y } = event.operation.transform;
      if (Math.hypot(x, y) <= MOVE_AFTER_LIFT_THRESHOLD) return;
      // Le doigt a franchi le seuil → bascule en drag, le menu s'efface. On garde
      // `liftActive` vrai jusqu'au end pour neutraliser un `contextmenu` natif tardif.
      movedRef.current = true;
      close();
    },
    onDragEnd(event) {
      if (String(event.operation.source?.id) !== sourceId) return;
      // Fin de geste : un lift relâché sur place laisse le menu ouvert (on n'y
      // touche pas) ; `handleDragEnd` (Sidebar) est no-op car l'index n'a pas bougé.
      liftActiveRef.current = false;
      movedRef.current = false;
      setLiftActive(false);
    },
  });

  return { liftActive };
}
