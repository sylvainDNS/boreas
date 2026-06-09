import { type FormEvent, useEffect, useId, useState } from "react";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";

/**
 * Dialog générique à un seul champ texte (#13). Réutilisé pour créer/renommer un
 * Folder et renommer un Feed : le composant gère la saisie locale, l'appelant
 * fournit la mutation via `onSubmit` + `pending`/`errorText` et pilote `open`
 * (qu'il ferme au succès). Le champ est réinitialisé à `initialValue` à chaque
 * ouverture. Le bouton est désactivé tant que le champ (rogné) est vide.
 */
export function NameDialog({
  open,
  onClose,
  title,
  label,
  submitLabel,
  initialValue = "",
  placeholder,
  pending = false,
  errorText,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  label: string;
  submitLabel: string;
  initialValue?: string;
  placeholder?: string;
  pending?: boolean;
  errorText?: string;
  onSubmit: (name: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  const inputId = useId();

  // Recharge la valeur initiale à chaque ouverture (et quand elle change).
  useEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || pending) return;
    onSubmit(trimmed);
  }

  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <form className="space-y-4" onSubmit={handleSubmit}>
        <div>
          <label
            htmlFor={inputId}
            className="mb-1 block font-medium text-muted text-xs uppercase tracking-wide"
          >
            {label}
          </label>
          <input
            id={inputId}
            type="text"
            required
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            className="min-h-11 w-full rounded-card border border-border bg-bg px-3 text-sm outline-none focus:border-accent focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
          />
        </div>
        {errorText && (
          <p className="text-red-600 text-sm dark:text-red-400" role="alert">
            {errorText}
          </p>
        )}
        <Button
          type="submit"
          className="w-full"
          disabled={pending || value.trim() === ""}
        >
          {pending ? "…" : submitLabel}
        </Button>
      </form>
    </Dialog>
  );
}
