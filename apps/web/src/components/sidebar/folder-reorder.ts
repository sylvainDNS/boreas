import { rankBetween } from "@boreas/shared/rank";
import type { Folder } from "../../lib/folders";

/**
 * Type du draggable « dossier » (réordonnancement des Folders, #109). Distinct du
 * type Feed (`FEED_DRAG_TYPE`) : `onDragEnd` discrimine dessus pour router vers le
 * réordonnancement (source dossier) ou le déplacement de Feed (source feed). Un
 * dossier reste **cible** de drop d'un Feed (il l'accepte aussi), mais n'est
 * **source** que de ce type.
 */
export const FOLDER_DRAG_TYPE = "folder";

/**
 * Données portées par un dossier sortable (#109). `name` alimente le fantôme du
 * `DragOverlay` pendant le réordonnancement, sans relecture du cache.
 */
export interface FolderDragData {
  name: string;
}

/**
 * Calcule le nouveau rang fractionnaire (ADR 0020) d'un dossier déplacé de
 * `fromIndex` à `toIndex` dans la liste triée par rang, ou `null` si le
 * déplacement est un no-op (`fromIndex === toIndex`).
 *
 * On **retire** d'abord l'item de `fromIndex`, puis on lit ses voisins
 * encadrants **dans la liste réordonnée** : le voisin avant
 * (`reordered[toIndex - 1]`) et le voisin après (`reordered[toIndex + 1]`, car
 * l'item déplacé occupe désormais `reordered[toIndex]`). Retirer avant de lire
 * évite l'off-by-one entre montée et descente (l'item déplacé ne compte plus
 * comme son propre voisin). `rankBetween` gère la tête (`before = null`), la
 * queue (`after = null`) et la liste à un seul élément.
 *
 * Renvoie `null` (réordonnancement abandonné, pas de crash) quand les deux
 * voisins encadrants ont un rang **non strictement ordonné** (`before >= after`)
 * — cas dégénéré atteignable : deux Folders peuvent partager un rang (`GET`
 * départage par `id`, rééquilibrage rare ou conflit multi-appareils, ADR 0018),
 * et `rankBetween` lèverait alors. Le prochain poll réconcilie l'ordre.
 *
 * Seul le rang de l'item déplacé est calculé : une seule ligne sera réécrite
 * côté serveur (AC #109).
 */
export function computeFolderRank(
  folders: readonly Folder[],
  fromIndex: number,
  toIndex: number,
): string | null {
  if (fromIndex === toIndex) return null;

  const reordered = [...folders];
  const [moved] = reordered.splice(fromIndex, 1);
  if (!moved) return null;
  reordered.splice(toIndex, 0, moved);

  const before = reordered[toIndex - 1]?.rank ?? null;
  const after = reordered[toIndex + 1]?.rank ?? null;
  // Voisins de rang égal/inversé : non intercalable, on abandonne sans crash.
  if (before !== null && after !== null && before >= after) return null;
  return rankBetween(before, after);
}
