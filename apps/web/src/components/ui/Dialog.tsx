import { type ReactNode, useEffect, useId, useRef } from "react";
import { IconButton } from "./IconButton";

/**
 * Overlay modal du design system. Contrôlé (`open`/`onClose`). Overlay maison
 * plutôt que `<dialog>` natif : jsdom n'implémente pas `showModal()`, ce qui
 * rendrait le composant intestable, et l'overlay nous laisse le plein contrôle
 * du style (tokens Kiwi). Accessibilité : `role="dialog"` + `aria-modal`,
 * fermeture par Échap et par clic sur le fond, focus posé à l'ouverture.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Ref vers le dernier `onClose` : permet aux effets de ne dépendre que de
  // `open`, sans se re-déclencher quand l'appelant passe une closure non
  // mémoïsée (sinon le focus serait volé à chaque frappe dans un champ).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Échap ferme. Abonné une seule fois par ouverture.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Pose le focus dans le panneau (premier champ focusable) à l'ouverture.
  useEffect(() => {
    if (!open) return;
    panelRef.current
      ?.querySelector<HTMLElement>("input, button, [tabindex]")
      ?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      {/* Fond cliquable = vrai bouton (accessible et focusable) plutôt qu'un
          div interactif ; il couvre l'écran, le panneau passe au-dessus. */}
      <button
        type="button"
        aria-label="Fermer"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/40"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative w-full max-w-md rounded-card border border-border bg-surface p-6 shadow-pop"
      >
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 id={titleId} className="font-semibold text-lg">
            {title}
          </h2>
          <IconButton label="Fermer" onClick={onClose}>
            ✕
          </IconButton>
        </div>
        {children}
      </div>
    </div>
  );
}
