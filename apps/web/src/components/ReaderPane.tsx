import { articleBody, type MockArticle } from "../mock";
import { Button } from "./ui/Button";

/** Panneau lecteur : en-tête d'article, actions, contenu mis en forme.
 *  Le contenu réel (extrait à l'ingestion) arrive en tranche #7 ; ici, corps factice. */
export function ReaderPane({ article }: { article: MockArticle }) {
  return (
    <article className="mx-auto max-w-2xl px-6 py-8 sm:px-8 sm:py-10">
      <div className="mb-2 font-medium text-accent text-sm">
        {article.feedName}
      </div>
      <h1 className="mb-3 font-read font-semibold text-2xl leading-tight sm:text-3xl">
        {article.title}
      </h1>
      <div className="mb-8 flex flex-wrap items-center gap-3 border-border border-b pb-4 text-muted text-sm">
        <span>{article.time}</span>
        <span className="ml-auto flex gap-2">
          <Button variant="outline">↗ Original</Button>
          <Button variant={article.saved ? "primary" : "outline"}>
            ★ {article.saved ? "Saved" : "Saver"}
          </Button>
        </span>
      </div>
      <div className="reader-prose">
        {articleBody.map((p) => (
          <p key={p}>{p}</p>
        ))}
      </div>
    </article>
  );
}
