import { createHash } from "node:crypto";

/**
 * Représente les champs stables d'un item de feed utilisés pour la déduplication.
 * Correspond à la spécification ADR 0001.
 */
export interface ArticleItem {
  /** Identifiant fourni par le feed (guid RSS ou id Atom). */
  guid?: string | null;
  /** URL de l'article. */
  link?: string | null;
  /** Titre de l'article (champ de repli pour le hash). */
  title?: string | null;
  /** Contenu brut (champ de repli pour le hash). */
  content?: string | null;
}

/**
 * Calcule une clé de déduplication stable pour un article.
 *
 * Cascade (ADR 0001) :
 *   1. guid  → préféré si présent et non vide
 *   2. link  → URL de l'article
 *   3. hash  → SHA-256 tronqué des champs stables (feedId + title + content)
 *
 * La clé ne dépend jamais de `fetched_at` ni d'aucune donnée de timing.
 */
export function articleKey(item: ArticleItem, feedId: string): string {
  const guid = item.guid?.trim();
  if (guid) {
    return `guid:${guid}`;
  }
  const link = item.link?.trim();
  if (link) {
    return `link:${link}`;
  }
  const stable = JSON.stringify([feedId, item.title ?? "", item.content ?? ""]);
  const digest = createHash("sha256").update(stable).digest("hex").slice(0, 32);
  return `hash:${digest}`;
}
