import type { Feed } from "../../lib/feeds";
import type { Folder } from "../../lib/folders";

/**
 * Modèle de vue **pur** (sans React) de la Sidebar (#48). Centralise le
 * regroupement Feeds/Folders et l'union des dialogues, isolés du composant pour
 * être testables en unitaire.
 */

/** Classe de base d'une ligne de navigation (Feed/Folder/vue globale). */
export const itemBase =
  "flex min-h-11 w-full items-center gap-2 rounded-card px-3 text-left text-sm transition-colors hover:bg-surface-2";
/** Classe additionnelle d'une ligne active (route courante). */
export const itemActive = "bg-surface-2 font-medium text-accent";

/**
 * Style du libellé d'une ligne flux/dossier selon l'état de lecture (#115) :
 * **gras** si non-lus, grisé (`text-muted`) si tout est lu. Factorisé entre
 * `FeedRow` et `FolderTree` pour garantir une apparence cohérente.
 */
export const unreadNameClass = (hasUnread: boolean) =>
  hasUnread ? "font-medium" : "text-muted";

/**
 * Message commun des ops Feeds/Folders **online-only** désactivées hors-ligne
 * (#81, ADR 0018) : ajout/déplacement/renommage/suppression/désabonnement
 * exigent le réseau. Posé en `title` (info-bulle) sur les déclencheurs désactivés.
 */
export const OFFLINE_OP_TITLE = "Indisponible hors-ligne";

/**
 * Type des draggables de la Sidebar (drag-n-drop des Feeds). Les droppables
 * (dossiers + zone « sans dossier ») n'acceptent que ce type, ce qui isole le
 * drag des Feeds de tout autre usage futur de dnd-kit.
 */
export const FEED_DRAG_TYPE = "feed";

/**
 * Données portées par un Feed draggable. `folderId` permet à `onDragEnd` de
 * court-circuiter un drop sur le dossier courant (no-op) ; `label` alimente le
 * fantôme du `DragOverlay` sans relecture du cache.
 */
export interface FeedDragData {
  folderId: string | null;
  label: string;
}

/**
 * Identifiant du droppable « Flux (sans dossier) ». Sentinelle distincte
 * d'un `folderId` réel : lâcher un Feed dessus le désassigne (`folderId = null`).
 * `resolveDropTarget` la retraduit en `null`.
 */
export const UNFILED_DROPPABLE_ID = "sidebar:unfiled";

/**
 * Traduit l'identifiant d'un droppable de la Sidebar en `folderId` cible pour
 * `move` : la sentinelle « sans dossier » → `null` (désassignation), tout autre
 * id → l'id de Folder tel quel. Pur et testable, sans dépendance à dnd-kit.
 */
export function resolveDropTarget(droppableId: string): string | null {
  return droppableId === UNFILED_DROPPABLE_ID ? null : droppableId;
}

/** Résultat du regroupement : feeds par dossier + feeds sans dossier. */
export interface GroupedFeeds {
  /** Feeds rattachés à un Folder **connu**, indexés par `folderId`. */
  feedsByFolder: ReadonlyMap<string, Feed[]>;
  /** Feeds sans dossier (ou rattachés à un Folder inconnu). */
  unfiledFeeds: Feed[];
}

/**
 * Groupe les feeds par folder en un seul passage (évite un filter O(feeds) par
 * folder rendu). Un feed dont le `folderId` ne correspond à aucun Folder connu
 * (folder supprimé/non encore chargé) est traité comme « sans dossier » : il
 * reste ainsi visible plutôt que de disparaître de la sidebar. L'ordre des feeds
 * d'entrée est préservé au sein de chaque dossier et dans « sans dossier ».
 */
export function groupFeedsByFolder(
  folders: readonly Folder[],
  feeds: readonly Feed[],
): GroupedFeeds {
  const known = new Set(folders.map((f) => f.id));
  const byFolder = new Map<string, Feed[]>();
  const unfiled: Feed[] = [];
  for (const feed of feeds) {
    if (feed.folderId != null && known.has(feed.folderId)) {
      const list = byFolder.get(feed.folderId);
      if (list) list.push(feed);
      else byFolder.set(feed.folderId, [feed]);
    } else {
      unfiled.push(feed);
    }
  }
  return { feedsByFolder: byFolder, unfiledFeeds: unfiled };
}

/**
 * Dialogue ouvert de la Sidebar (#48). Union discriminée sur `kind` à 6 variants,
 * remplaçant les `useState` indépendants : un seul dialogue est ouvert à la
 * fois (`null` = aucun). Chaque variant porte la cible nécessaire à son rendu.
 * Plus de variant `deleteFeed` (#113) : la suppression destructive d'un feed
 * n'a plus de point d'entrée dans l'UI (Se désabonner est l'action unifiée).
 */
export type SidebarDialog =
  | { kind: "addFeed" }
  | { kind: "createFolder" }
  | { kind: "renameFolder"; folder: Folder }
  | { kind: "renameFeed"; feed: Feed }
  | { kind: "deleteFolder"; folder: Folder }
  | { kind: "unsubscribeFeed"; feed: Feed };
