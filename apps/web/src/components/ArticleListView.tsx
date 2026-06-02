import { useState } from "react";
import type { MockArticle } from "../mock";
import { ArticleCard } from "./ArticleCard";
import { EmptyState } from "./EmptyState";
import { ReaderPane } from "./ReaderPane";
import { CountBadge } from "./ui/Badge";
import { IconButton } from "./ui/IconButton";

interface ArticleListViewProps {
  title: string;
  articles: MockArticle[];
  /** Texte de l'état vide quand la liste est vide. */
  emptyLabel?: string;
}

/** Vue générique « liste + lecteur » des tranches de lecture (#6, #8, #9, #13…).
 *  Desktop ≥ lg : deux panneaux côte à côte. En dessous : drill-down liste → lecteur. */
export function ArticleListView({
  title,
  articles,
  emptyLabel = "Aucun article à afficher.",
}: ArticleListViewProps) {
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  // Cherche la sélection DANS la liste courante : si l'article sélectionné
  // n'appartient pas à cette vue (navigation entre routes réutilisant ce
  // composant, ex. feed → feed), `selected` devient undefined et le lecteur
  // retombe sur son état vide — au lieu d'afficher un article hors-liste.
  const selected = articles.find((a) => a.id === selectedId);
  const unreadCount = articles.filter((a) => a.unread).length;
  const hasSelection = Boolean(selected);

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
          {articles.length === 0 ? (
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
