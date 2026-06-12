import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import type { ArticleSearch } from "../lib/article-search";
import type { ArticleView } from "../lib/use-article-view";
import { ArticleCard } from "./ArticleCard";
import { EmptyState } from "./EmptyState";
import { ReaderPane } from "./ReaderPane";
import { CountBadge } from "./ui/Badge";
import { IconButton } from "./ui/IconButton";

interface ArticleListViewProps {
  /** Modèle de vue calculé par `useArticleView(scope)` (#47). */
  view: ArticleView;
}

/** Vue générique « liste + lecteur » des tranches de lecture (#6, #8, #9, #13…).
 *  Desktop ≥ lg : deux panneaux côte à côte. En dessous : drill-down liste → lecteur.
 *  La vue « Tous les non-lus » (#6) y branche un scroll infini via `onEndReached`.
 *
 *  Toute la donnée et les callbacks proviennent d'un unique `view` (#47) : les
 *  routes ne câblent plus 15 props pass-through, mais délèguent à `useArticleView`.
 */
export function ArticleListView({ view }: ArticleListViewProps) {
  const {
    title,
    articles,
    emptyLabel = "Aucun article à afficher.",
    unreadCount,
    isLoading = false,
    isError = false,
    hasNextPage = false,
    isFetchingNextPage = false,
    onEndReached,
    showRead,
    onToggleShowRead,
    onToggleRead,
    onToggleSaved,
    onMarkAllRead,
    onRefresh,
    isRefreshing = false,
  } = view;

  // L'Article ouvert vit dans l'URL (`?article=<id>`, ADR 0016) : le back système
  // ramène à la liste et l'Article est deep-linkable. `strict: false` lit le
  // search param quelle que soit la route liste qui monte ce composant.
  // `useNavigate()` non lié à une route (ce composant est monté par 4 routes
  // différentes) se type sur la racine, où le search est `never`. On le re-type
  // sur notre search param ; chaque route le valide via `validateArticleSearch`.
  const navigate = useNavigate() as (opts: {
    search: (prev: ArticleSearch) => ArticleSearch;
  }) => Promise<void>;
  const { article: selectedId } = useSearch({ strict: false }) as ArticleSearch;
  const openArticle = (id: string) => {
    // Push (pas de replace) : chaque Article ouvert pousse une entrée d'historique.
    void navigate({ search: (prev) => ({ ...prev, article: id }) });
  };
  const closeArticle = () => {
    void navigate({ search: ({ article: _drop, ...rest }) => rest });
  };
  // Cherche la sélection DANS la liste courante : sert de fast-path pour un
  // en-tête de lecteur instantané. Peut être `undefined` (deep-link/refresh sur
  // un Article hors de la page chargée) → le lecteur retombe sur la query détail.
  const selected = articles.find((a) => a.id === selectedId);
  // Compteur exact fourni par l'API (#8) ; sinon retombe sur le décompte local
  // (vues encore sur données mock jusqu'à #13).
  const unread = unreadCount ?? articles.filter((a) => a.unread).length;
  // Dérive du param d'URL (pas de `selected`) : le lecteur s'affiche même si
  // l'item n'est pas dans la liste, le temps que la query détail réponde.
  const hasSelection = Boolean(selectedId);

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
          <CountBadge count={unread} />
          <div className="ml-auto flex items-center gap-1">
            {onToggleShowRead && (
              <button
                type="button"
                role="switch"
                aria-checked={showRead ?? false}
                onClick={onToggleShowRead}
                className="rounded-card px-2 py-1 text-muted text-xs transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
              >
                {showRead ? "Masquer les lus" : "Afficher les lus"}
              </button>
            )}
            <IconButton
              label="Rafraîchir"
              onClick={onRefresh}
              disabled={!onRefresh || isRefreshing}
              className="disabled:cursor-not-allowed disabled:opacity-40"
            >
              <span className={isRefreshing ? "inline-block animate-spin" : ""}>
                ↻
              </span>
            </IconButton>
            <IconButton
              label="Tout marquer comme lu"
              onClick={onMarkAllRead}
              disabled={!onMarkAllRead || unread === 0}
              className="disabled:cursor-not-allowed disabled:opacity-40"
            >
              ✓
            </IconButton>
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
                  onSelect={() => openArticle(article.id)}
                  onToggleRead={
                    onToggleRead
                      ? (read) => onToggleRead(article.id, read)
                      : undefined
                  }
                  onToggleSaved={
                    onToggleSaved
                      ? (saved) => onToggleSaved(article.id, saved)
                      : undefined
                  }
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
        {/* Barre retour (mobile uniquement). Retire le param plutôt que
            history.back() : un deep-link à froid n'a pas d'entrée précédente. */}
        {selectedId && (
          <div className="flex h-14 shrink-0 items-center border-border border-b px-2 lg:hidden">
            <IconButton label="Retour à la liste" onClick={closeArticle}>
              ←
            </IconButton>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {selectedId ? (
            <ReaderPane articleId={selectedId} listItem={selected} />
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
