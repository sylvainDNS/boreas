import {
  type UseQueryResult,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import {
  type Article,
  type ArticleDetail,
  articleDetailQueryOptions,
  markArticleReadInListCache,
} from "../lib/articles";
import { EmptyState } from "./EmptyState";
import { buttonClasses } from "./ui/Button";

/**
 * Panneau lecteur : en-tête (métadonnées de la liste, instantanées) + contenu
 * plein chargé via `GET /api/articles/:id`. Ce GET marque l'Article Read côté
 * serveur (#7) ; à la réussite, on retire l'état non-lu du cache de la liste.
 * Le HTML rendu est sûr par construction (sanitization serveur, ADR 0007).
 */
export function ReaderPane({ article }: { article: Article }) {
  const queryClient = useQueryClient();
  const detail = useQuery(articleDetailQueryOptions(article.id));

  useEffect(() => {
    if (detail.isSuccess) {
      markArticleReadInListCache(queryClient, article.id);
    }
  }, [detail.isSuccess, article.id, queryClient]);

  // Préfère le lien du détail, mais retombe sur celui de la liste : « Original »
  // reste accessible même si le chargement du contenu échoue.
  const link = detail.data?.link ?? article.link;

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
          {link && (
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClasses("outline")}
            >
              ↗ Original
            </a>
          )}
        </span>
      </div>

      <ReaderBody detail={detail} hasOriginal={Boolean(link)} />
    </article>
  );
}

/** Corps du lecteur : états chargement / erreur / contenu indisponible / HTML. */
function ReaderBody({
  detail,
  hasOriginal,
}: {
  detail: UseQueryResult<ArticleDetail>;
  hasOriginal: boolean;
}) {
  if (detail.isPending) {
    return <p className="py-8 text-center text-muted text-sm">Chargement…</p>;
  }
  if (detail.isError) {
    return (
      <EmptyState icon="⚠️" title="Impossible de charger l'article">
        Réessayez dans un instant.
      </EmptyState>
    );
  }
  if (!detail.data?.content) {
    return (
      <EmptyState icon="📄" title="Contenu indisponible">
        {hasOriginal
          ? "Ouvrez l'article original pour le lire."
          : "Aucun contenu extrait pour cet article."}
      </EmptyState>
    );
  }
  return (
    <div
      className="reader-prose"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: HTML sanitizé côté serveur avant stockage (ADR 0007)
      dangerouslySetInnerHTML={{ __html: detail.data.content }}
    />
  );
}
