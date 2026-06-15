import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";

/**
 * Champ de recherche de la sidebar (#73, ADR 0018). À la soumission, navigue vers
 * `/search?q=<requête>` : la recherche s'exécute **hors-ligne** sur le réplica
 * (cf. `useSearchView`). Champ contrôlé, initialisé sur la requête courante
 * (`initialQuery`) pour rester en phase avec l'URL au rechargement d'un deep-link.
 *
 * Composant mince et isolé du reste de la sidebar pour rester testable et ne pas
 * alourdir `Sidebar` (qui porte déjà le drag-n-drop et les dialogues).
 */
export function SidebarSearch({
  initialQuery = "",
  onNavigate,
}: {
  initialQuery?: string;
  onNavigate?: () => void;
}) {
  const navigate = useNavigate();
  const [value, setValue] = useState(initialQuery);

  // Re-synchronise le champ quand l'URL change (`?q`) sans remontage du composant
  // (navigation in-app vers une autre recherche / deep-link) : sans ça, le champ
  // garderait la requête précédente alors que les résultats affichent la nouvelle.
  useEffect(() => {
    setValue(initialQuery);
  }, [initialQuery]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const q = value.trim();
    if (q === "") return;
    onNavigate?.();
    void navigate({ to: "/search", search: { q } });
  }

  return (
    <search className="px-2 pb-1">
      <form onSubmit={handleSubmit}>
        <label htmlFor="sidebar-search" className="sr-only">
          Rechercher des articles
        </label>
        <input
          id="sidebar-search"
          type="search"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Rechercher…"
          className="min-h-11 w-full rounded-card border border-border bg-bg px-3 text-sm outline-none focus:border-accent focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
        />
      </form>
    </search>
  );
}
