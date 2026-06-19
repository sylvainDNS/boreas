import { desc, eq, isNull, type SQL } from "drizzle-orm";
import type { Db } from "./db";
import { feeds } from "./db";

/**
 * Prédicat SQL du **conteneur** d'un Feed (#110, ADR 0020) : un Folder donné
 * (`folder_id = folderId`) OU la zone « sans dossier » (`folder_id IS NULL` quand
 * `folderId` est `null`). Capture en un seul endroit l'invariant « un Feed
 * appartient à au plus un Folder, sinon il est non classé » — au lieu de répéter
 * le ternaire `isNull / eq` sur chaque site qui scope un rang par conteneur.
 */
export function feedContainerScope(folderId: string | null): SQL {
  return folderId === null
    ? isNull(feeds.folder_id)
    : eq(feeds.folder_id, folderId);
}

/**
 * Dernier rang (lexicographiquement le plus haut) du conteneur cible, ou `null`
 * si le conteneur est vide. Sert à placer un Feed **en fin de conteneur** via
 * `rankBetween(last, null)` — partagé par l'abonnement, le déplacement (PATCH) et
 * l'import OPML, pour que le scoping du rang reste cohérent entre ces chemins.
 */
export async function lastFeedRankInContainer(
  db: Db,
  folderId: string | null,
): Promise<string | null> {
  const [last] = await db
    .select({ rank: feeds.rank })
    .from(feeds)
    .where(feedContainerScope(folderId))
    .orderBy(desc(feeds.rank))
    .limit(1);
  return last?.rank ?? null;
}
