import {
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import {
  ARTICLES_COUNTS_KEY,
  type Article,
  type ArticleDetail,
  articleDetailQueryOptions,
  setArticleReadInListCaches,
  toggleArticleSavedMutationOptions,
} from "../lib/articles";
import { formatRelativeTime } from "../lib/time";
import { EmptyState } from "./EmptyState";
import { buttonClasses } from "./ui/Button";

/**
 * Panneau lecteur, piloté par `articleId` (search param `?article`, ADR 0016).
 * En-tête : préfère `listItem` (métadonnées de la liste, rendu instantané au clic)
 * et retombe sur la query détail quand l'item n'est pas dans la page chargée
 * (deep-link/refresh). Contenu plein chargé via `GET /api/articles/:id` ; ce GET
 * marque l'Article Read côté serveur (#7) → à la réussite, on retire l'état
 * non-lu du cache de la liste. Le HTML rendu est sûr par construction
 * (sanitization serveur, ADR 0007).
 */
export function ReaderPane({
  articleId,
  listItem,
}: {
  articleId: string;
  listItem?: Article;
}) {
  const queryClient = useQueryClient();
  const detail = useQuery(articleDetailQueryOptions(articleId));
  const toggleSaved = useMutation(
    toggleArticleSavedMutationOptions(queryClient),
  );

  // « Était non-lu » : item de liste si présent (connu avant le GET), sinon
  // l'état pré-marquage renvoyé par le détail (disponible à la réussite).
  const wasUnread = listItem?.unread ?? detail.data?.unread ?? false;
  useEffect(() => {
    // N'aligne le cache que si l'article était non-lu : le GET du détail vient
    // de le marquer Read côté serveur (#7). Rouvrir un article déjà lu n'a rien
    // changé en base — inutile de repatcher les listes ni d'invalider les
    // compteurs (#8). En deep-link, l'article peut n'être dans aucune liste en
    // cache : le patch est alors un no-op, seule l'invalidation des compteurs agit.
    if (detail.isSuccess && wasUnread) {
      setArticleReadInListCaches(queryClient, articleId, true);
      void queryClient.invalidateQueries({ queryKey: ARTICLES_COUNTS_KEY });
    }
  }, [detail.isSuccess, articleId, wasUnread, queryClient]);

  // Tant qu'on n'a ni item de liste ni détail, rien à afficher : état chargement
  // plein-panneau (cas deep-link à froid) plutôt qu'un en-tête vide clignotant.
  if (!listItem && detail.isPending) {
    return <p className="py-8 text-center text-muted text-sm">Chargement…</p>;
  }

  // Métadonnées d'en-tête : item de liste prioritaire, détail en repli.
  const feedName = listItem?.feedName ?? detail.data?.feedName ?? "";
  const title = listItem?.title ?? detail.data?.title ?? "(sans titre)";
  const time =
    listItem?.time ??
    (detail.data?.publishedAt
      ? formatRelativeTime(detail.data.publishedAt)
      : "");
  const saved = listItem?.saved ?? detail.data?.saved ?? false;
  // Préfère le lien du détail, mais retombe sur celui de la liste : « Original »
  // reste accessible même si le chargement du contenu échoue.
  const link = detail.data?.link ?? listItem?.link ?? null;

  return (
    <article className="mx-auto max-w-2xl px-6 py-8 sm:px-8 sm:py-10">
      <div className="mb-2 font-medium text-accent text-sm">{feedName}</div>
      <h1 className="mb-3 font-read font-semibold text-2xl leading-tight sm:text-3xl">
        {title}
      </h1>
      <div className="mb-8 flex flex-wrap items-center gap-3 border-border border-b pb-4 text-muted text-sm">
        <span>{time}</span>
        <span className="ml-auto flex gap-2">
          <button
            type="button"
            onClick={() => toggleSaved.mutate({ id: articleId, saved: !saved })}
            aria-pressed={saved}
            className={buttonClasses("outline")}
          >
            {saved ? "★ Sauvegardé" : "☆ Sauvegarder"}
          </button>
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
