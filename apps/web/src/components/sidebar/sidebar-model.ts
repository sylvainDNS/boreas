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
 * Dialogue ouvert de la Sidebar (#48). Union discriminée sur `kind` à 7 variants,
 * remplaçant les 6 `useState` indépendants : un seul dialogue est ouvert à la
 * fois (`null` = aucun). Chaque variant porte la cible nécessaire à son rendu.
 */
export type SidebarDialog =
  | { kind: "addFeed" }
  | { kind: "createFolder" }
  | { kind: "renameFolder"; folder: Folder }
  | { kind: "renameFeed"; feed: Feed }
  | { kind: "deleteFolder"; folder: Folder }
  | { kind: "unsubscribeFeed"; feed: Feed }
  | { kind: "deleteFeed"; feed: Feed };
