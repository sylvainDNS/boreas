import type { MockArticle } from "../mock";
import { FeedChip } from "./ui/Badge";

interface ArticleCardProps {
  article: MockArticle;
  selected: boolean;
  onSelect: () => void;
}

/** Élément de liste « carte » (direction Moderne carte). */
export function ArticleCard({ article, selected, onSelect }: ArticleCardProps) {
  return (
    <button type="button" onClick={onSelect} className="block w-full text-left">
      <div
        className={`rounded-card border bg-surface p-4 shadow-card transition ${
          selected
            ? "border-accent ring-2 ring-accent"
            : "border-border hover:-translate-y-0.5"
        }`}
      >
        <div className="mb-2 flex items-center gap-2">
          <FeedChip>{article.feedName}</FeedChip>
          {article.unread && (
            <>
              <span className="size-2 rounded-full bg-accent" aria-hidden />
              <span className="sr-only">Non lu</span>
            </>
          )}
          <span className="ml-auto text-muted text-xs">{article.time}</span>
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
    </button>
  );
}
