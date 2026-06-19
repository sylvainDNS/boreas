import { rankBetween } from "@boreas/shared/rank";
import type { Feed } from "../../lib/feeds";

/**
 * Calcule le nouveau rang fractionnaire (ADR 0020) d'un Feed déplacé de
 * `fromIndex` à `toIndex` **au sein de la liste de son conteneur** (le Folder, ou
 * la zone « sans dossier »), ou `null` si le déplacement est un no-op
 * (`fromIndex === toIndex`). Jumeau de `computeFolderRank` (#109), appliqué au
 * réordonnancement intra-conteneur des Feeds (#111) — le type `FEED_DRAG_TYPE` et
 * `FeedDragData` restent définis dans `sidebar-model` (pas de doublon) ; le
 * routage reorder-vs-move se fait sur le **group** (conteneur) du sortable.
 *
 * On **retire** d'abord l'item de `fromIndex`, puis on lit ses voisins
 * encadrants **dans la liste réordonnée** : le voisin avant
 * (`reordered[toIndex - 1]`) et le voisin après (`reordered[toIndex + 1]`, car
 * l'item déplacé occupe désormais `reordered[toIndex]`). Retirer avant de lire
 * évite l'off-by-one entre montée et descente. `rankBetween` gère la tête
 * (`before = null`), la queue (`after = null`) et la liste à un seul élément.
 *
 * Renvoie `null` (réordonnancement abandonné, pas de crash) quand les deux
 * voisins encadrants ont un rang **non strictement ordonné** (`before >= after`)
 * — cas dégénéré atteignable : deux Feeds d'un même conteneur peuvent partager un
 * rang (`GET` départage par `id`, rééquilibrage rare ou conflit multi-appareils,
 * ADR 0018), et `rankBetween` lèverait alors. Le prochain poll réconcilie l'ordre.
 *
 * Seul le rang de l'item déplacé est calculé : une seule ligne sera réécrite
 * côté serveur (AC #111).
 */
export function computeFeedRank(
  feeds: readonly Feed[],
  fromIndex: number,
  toIndex: number,
): string | null {
  if (fromIndex === toIndex) return null;

  const reordered = [...feeds];
  const [moved] = reordered.splice(fromIndex, 1);
  if (!moved) return null;
  reordered.splice(toIndex, 0, moved);

  const before = reordered[toIndex - 1]?.rank ?? null;
  const after = reordered[toIndex + 1]?.rank ?? null;
  // Voisins de rang égal/inversé : non intercalable, on abandonne sans crash.
  if (before !== null && after !== null && before >= after) return null;
  return rankBetween(before, after);
}
