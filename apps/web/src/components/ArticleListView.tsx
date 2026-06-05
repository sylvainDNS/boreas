import { useEffect, useRef, useState } from "react";
import type { Article } from "../lib/articles";
import { ArticleCard } from "./ArticleCard";
import { EmptyState } from "./EmptyState";
import { ReaderPane } from "./ReaderPane";
import { CountBadge } from "./ui/Badge";
import { IconButton } from "./ui/IconButton";

interface ArticleListViewProps {
  title: string;
  articles: Article[];
  /** Texte de l'état vide quand la liste est vide. */
  emptyLabel?: string;
  /** Chargement initial (première page). */
  isLoading?: boolean;
  /** Erreur de chargement. */
  isError?: boolean;
  /** Reste-t-il des pages à charger ? */
  hasNextPage?: boolean;
  /** Une page suivante est en cours de chargement. */
  isFetchingNextPage?: boolean;
  /** Demande la page suivante (scroll infini). */
  onEndReached?: () => void;
}

/** Vue générique « liste + lecteur » des tranches de lecture (#6, #8, #9, #13…).
 *  Desktop ≥ lg : deux panneaux côte à côte. En dessous : drill-down liste → lecteur.
 *  La vue « Tous les non-lus » (#6) y branche un scroll infini via `onEndReached`. */
export function ArticleListView({
  title,
  articles,
  emptyLabel = "Aucun article à afficher.",
  isLoading = false,
  isError = false,
  hasNextPage = false,
  isFetchingNextPage = false,
  onEndReached,
}: ArticleListViewProps) {
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  // Cherche la sélection DANS la liste courante : si l'article sélectionné
  // n'appartient pas à cette vue (navigation entre routes réutilisant ce
  // composant, ex. feed → feed), `selected` devient undefined et le lecteur
  // retombe sur son état vide — au lieu d'afficher un article hors-liste.
  const selected = articles.find((a) => a.id === selectedId);
  const unreadCount = articles.filter((a) => a.unread).length;
  const hasSelection = Boolean(selected);

  // Sentinelle de scroll infini : observe un élément en bas de liste et déclenche
  // le chargement de la page suivante dès qu'il devient visible.
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !onEndReached || !hasNextPage) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && !isFetchingNextPage) {
        onEndReached();
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [onEndReached, hasNextPage, isFetchingNextPage]);

  return (
    <div className="flex h-full min-h-0">
      {/* Panneau liste */}
      <section
        className={`min-h-0 flex-col border-border lg:flex lg:w-[24rem] lg:border-r ${
          hasSelection ? "hidden lg:flex" : "flex w-full"
        }`}
      >
        <div className="flex h-14 shrink-0 items-center gap-3 border-border border-b px-4">
          <h2 className="font-semibold">{title}</h2>
          <CountBadge count={unreadCount} />
          <div className="ml-auto flex items-center">
            <IconButton label="Rafraîchir">↻</IconButton>
            <IconButton label="Tout marquer comme lu">✓</IconButton>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {isError ? (
            <EmptyState icon="⚠️" title="Impossible de charger les articles">
              Réessayez dans un instant.
            </EmptyState>
          ) : isLoading ? (
            <EmptyState title="Chargement…" />
          ) : articles.length === 0 ? (
            <EmptyState title={emptyLabel} />
          ) : (
            <div className="space-y-3 p-3">
              {articles.map((article) => (
                <ArticleCard
                  key={article.id}
                  article={article}
                  selected={article.id === selectedId}
                  onSelect={() => setSelectedId(article.id)}
                />
              ))}
              {/* Sentinelle + indicateur de chargement de page suivante. */}
              <div ref={sentinelRef} className="h-px" />
              {isFetchingNextPage && (
                <p className="py-3 text-center text-muted text-sm">
                  Chargement…
                </p>
              )}
            </div>
          )}
        </div>
      </section>

      {/* Panneau lecteur */}
      <section
        className={`min-h-0 flex-1 flex-col ${
          hasSelection ? "flex" : "hidden lg:flex"
        }`}
      >
        {/* Barre retour (mobile uniquement) */}
        {selected && (
          <div className="flex h-14 shrink-0 items-center border-border border-b px-2 lg:hidden">
            <IconButton
              label="Retour à la liste"
              onClick={() => setSelectedId(undefined)}
            >
              ←
            </IconButton>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {selected ? (
            <ReaderPane article={selected} />
          ) : (
            <EmptyState icon="📖" title="Aucun article sélectionné">
              Choisissez un article dans la liste pour le lire ici.
            </EmptyState>
          )}
        </div>
      </section>
    </div>
  );
}
