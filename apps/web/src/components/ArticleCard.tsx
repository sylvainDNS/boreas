import type { Article } from "../lib/articles";
import { FeedChip } from "./ui/Badge";

interface ArticleCardProps {
  article: Article;
  selected: boolean;
  onSelect: () => void;
  /** Bascule Read↔non-lu sans ouvrir l'article (#8). */
  onToggleRead?: (read: boolean) => void;
  /** Bascule Saved↔non-Saved (#9). `saved` = nouvel état souhaité. */
  onToggleSaved?: (saved: boolean) => void;
}

/** Élément de liste « carte » (direction Moderne carte).
 *  Motif « cible étirée + action superposée » : un bouton plein-carte gère la
 *  sélection (pointer-events réactivés ponctuellement), et le bouton de bascule
 *  Read vit au-dessus — pas de bouton imbriqué (HTML invalide). */
export function ArticleCard({
  article,
  selected,
  onSelect,
  onToggleRead,
  onToggleSaved,
}: ArticleCardProps) {
  const toggleLabel = article.unread
    ? "Marquer comme lu"
    : "Marquer comme non lu";
  const savedLabel = article.saved ? "Retirer des Saved" : "Sauvegarder";
  return (
    <div
      className={`group relative rounded-card border bg-surface p-4 shadow-card transition ${
        selected
          ? "border-accent ring-2 ring-accent"
          : "border-border hover:-translate-y-0.5"
      }`}
    >
      {/* Cible de sélection étirée sur toute la carte. */}
      <button
        type="button"
        onClick={onSelect}
        aria-label={`Lire : ${article.title}`}
        className="absolute inset-0 z-0 rounded-card focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
      />

      {/* Contenu transparent aux clics ; les éléments interactifs les réactivent. */}
      <div className="pointer-events-none relative z-10">
        <div className="mb-2 flex items-center gap-2">
          <FeedChip>{article.feedName}</FeedChip>
          {article.unread && (
            <>
              <span className="size-2 rounded-full bg-accent" aria-hidden />
              <span className="sr-only">Non lu</span>
            </>
          )}
          <span className="ml-auto text-muted text-xs">{article.time}</span>
          {onToggleSaved && (
            <button
              type="button"
              onClick={() => onToggleSaved(!article.saved)}
              aria-label={savedLabel}
              aria-pressed={article.saved}
              title={savedLabel}
              className={`pointer-events-auto grid size-7 place-items-center rounded-full transition hover:bg-surface-2 hover:text-text focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-accent ${
                article.saved
                  ? "text-accent opacity-100"
                  : "text-muted opacity-100 lg:opacity-0 lg:group-hover:opacity-100"
              }`}
            >
              {article.saved ? "★" : "☆"}
            </button>
          )}
          {onToggleRead && (
            <button
              type="button"
              onClick={() => onToggleRead(article.unread)}
              aria-label={toggleLabel}
              title={toggleLabel}
              className="pointer-events-auto grid size-7 place-items-center rounded-full text-muted opacity-100 transition hover:bg-surface-2 hover:text-text focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-accent lg:opacity-0 lg:group-hover:opacity-100"
            >
              {article.unread ? "✓" : "↺"}
            </button>
          )}
        </div>
        <h3
          className={`mb-1 text-[1.02rem] leading-snug ${
            article.unread ? "font-semibold" : "font-normal text-muted"
          }`}
        >
          {article.title}
        </h3>
        <p className="line-clamp-2 text-muted text-sm">{article.excerpt}</p>
      </div>
    </div>
  );
}
