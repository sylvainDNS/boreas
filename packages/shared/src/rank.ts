import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

/**
 * Rang fractionnaire (ADR 0020) — ordre manuel des Folders et Feeds persisté en
 * **clé lexicographique** (type *fractional indexing* / LexoRank). Réordonner ne
 * recalcule que le rang de l'item déplacé (entre ses deux voisins) : une seule
 * ligne réécrite, un seul `updated_at` bumpé (cohérent avec la sync delta, ADR 0018).
 *
 * Ce module isole la lib `fractional-indexing` derrière une frontière stable et
 * réutilisable par les Folders (#108) comme par les Feeds (à venir).
 */

/**
 * Calcule un rang qui s'insère **strictement entre** `before` et `after`.
 *
 * - `before = null` → insertion en **tête** (avant le premier).
 * - `after = null` → insertion en **fin** (après le dernier).
 * - `before = after = null` → première clé d'un conteneur vide.
 *
 * La clé renvoyée se trie lexicographiquement entre les deux bornes ; deux clés
 * adjacentes admettent toujours une intercalation (rééquilibrage rare, jamais une
 * collision). Réexpose `generateKeyBetween` avec un nommage métier.
 */
export function rankBetween(
  before: string | null,
  after: string | null,
): string {
  return generateKeyBetween(before, after);
}

/**
 * Produit `n` rangs initiaux strictement croissants, en partant de rien.
 *
 * Sert au **backfill** d'un conteneur existant : on passe les items déjà ordonnés
 * (ex. Folders triés par `name ASC`) et on leur affecte ces clés dans l'ordre. Les
 * clés sont des clés `fractional-indexing` valides — toute paire adjacente reste
 * intercalable par {@link rankBetween} (régression couverte par `rank.test.ts`).
 */
export function initialRanks(n: number): string[] {
  if (n <= 0) return [];
  return generateNKeysBetween(null, null, n);
}

/**
 * Produit `n` rangs strictement croissants à placer **après** `lastRank` (fin de
 * liste), ou en partant de zéro si `lastRank` est `null`.
 *
 * Sert aux insertions **en lot** en queue d'un conteneur (ex. import OPML qui crée
 * plusieurs Folders d'un coup, #108 ; demain l'ajout groupé de Feeds). Les clés
 * restent intercalables par {@link rankBetween}.
 */
export function ranksAfter(lastRank: string | null, n: number): string[] {
  if (n <= 0) return [];
  return generateNKeysBetween(lastRank, null, n);
}
