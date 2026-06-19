import type { Feed } from "../../lib/feeds";
import type { Folder } from "../../lib/folders";
import { computeFeedRank, rankAtInsertion } from "./feed-reorder";

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
 * Style des **boutons « + » discrets** des en-têtes de la Sidebar (nouveau
 * dossier, ajouter un flux sans dossier, ajouter un flux dans un dossier #118).
 * Factorisé pour qu'un restyle (survol, focus, état désactivé) reste cohérent
 * entre les trois déclencheurs (cf. `itemBase`/`OFFLINE_OP_TITLE`).
 */
export const addIconButtonClass =
  "rounded-card px-1.5 text-base text-muted leading-none transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent";

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

/**
 * Vue minimale de la source d'un drag de Feed pour `resolveFeedDragEnd`,
 * découplée des types dnd-kit (testable sans monter de DragDropProvider). Quand
 * `isSortable` est vrai, les champs sortable (`initialGroup`/`group`/index)
 * situent le Feed dans son conteneur d'origine et projeté ; `folderId` est le
 * conteneur courant du Feed (porté par `FeedDragData`).
 */
export interface FeedDragSource {
  id: string;
  /** Le Feed est un sortable (vrai en pratique, #111) : permet le reorder. */
  isSortable: boolean;
  /** Conteneur sortable d'origine (id de Folder ou sentinelle « sans dossier »). */
  initialGroup?: string;
  /** Conteneur sortable projeté à la dépose (dnd-kit y reflète la cible). */
  group?: string;
  /** Index d'origine dans la liste triée du conteneur. */
  initialIndex?: number;
  /** Index projeté à la dépose dans le conteneur. */
  index?: number;
  /** Folder de rattachement courant du Feed (null = sans dossier). */
  folderId: string | null;
}

/**
 * Action décidée par `resolveFeedDragEnd` : réordonner intra-conteneur (#111),
 * déplacer **et positionner** inter-conteneur en un PATCH atomique (#112),
 * déplacer sans position (repli #13), ou rien.
 */
export type FeedDragAction =
  | { kind: "reorder"; id: string; rank: string }
  | { kind: "move-and-rank"; id: string; folderId: string | null; rank: string }
  | { kind: "move"; id: string; folderId: string | null }
  | { kind: "none" };

/**
 * Décide, à la fin d'un drag de Feed, entre **réordonnancement intra-conteneur**
 * (#111), **déplacement inter-conteneur à position précise** (#112) et
 * **déplacement de repli** (#13) — logique pure et testable, extraite de
 * `Sidebar.handleDragEnd`. Trois branches, dans cet ordre :
 *
 * 1. **reorder** (#111) — source sortable et conteneur **inchangé**
 *    (`initialGroup === group` ; dnd-kit projette le group de la cible sur le
 *    sortable pendant le drag). `computeFeedRank` calcule le rang sur la liste
 *    **triée** du conteneur d'origine (résolue via `feedsInContainer`, la
 *    sentinelle « sans dossier » retraduite en `null`). No-op → `none`.
 *
 * 2. **move-and-rank** (#112) — source sortable mais conteneur **changé**
 *    (`group` projeté défini et différent de `initialGroup`, `index` défini). Le
 *    conteneur cible vient de **`source.group`** (le group projeté par dnd-kit en
 *    cross-group), **PAS** de `targetFolderId`/`target.id` : c'est la correction de
 *    la limitation #111, qui résolvait alors la cible depuis le droppable survolé.
 *    `rankAtInsertion` calcule le rang à la position projetée dans la liste triée
 *    du conteneur cible (l'item n'y est pas encore : le cache n'a pas bougé).
 *    Voisins dégénérés → `none`.
 *
 * 3. **move** (repli #13) — source **non sortable** (en-tête dossier, droppable),
 *    ou sortable sans group/index projetés. Exige une cible (`targetFolderId`
 *    défini — `undefined` = drop hors zone → `none`). Drop sur le conteneur
 *    courant (même `folderId`) → `none`. Aucun rang : le serveur réattribue en fin
 *    de conteneur cible (#110).
 */
export function resolveFeedDragEnd(
  source: FeedDragSource,
  targetFolderId: string | null | undefined,
  feedsInContainer: (folderId: string | null) => readonly Feed[],
): FeedDragAction {
  if (
    source.isSortable &&
    source.initialGroup !== undefined &&
    source.initialGroup === source.group &&
    source.initialIndex !== undefined &&
    source.index !== undefined
  ) {
    const folderId = resolveDropTarget(source.initialGroup);
    const rank = computeFeedRank(
      feedsInContainer(folderId),
      source.initialIndex,
      source.index,
    );
    return rank === null
      ? { kind: "none" }
      : { kind: "reorder", id: source.id, rank };
  }

  // Déplacement inter-conteneur à position précise (#112) : conteneur cible résolu
  // depuis le group projeté par dnd-kit (cross-group), et non depuis le droppable
  // survolé — correction de la limitation #111.
  if (
    source.isSortable &&
    source.initialGroup !== undefined &&
    source.initialGroup !== source.group &&
    source.group !== undefined &&
    source.index !== undefined
  ) {
    const folderId = resolveDropTarget(source.group);
    const rank = rankAtInsertion(feedsInContainer(folderId), source.index);
    return rank === null
      ? { kind: "none" }
      : { kind: "move-and-rank", id: source.id, folderId, rank };
  }

  if (targetFolderId === undefined) return { kind: "none" };
  if (source.folderId === targetFolderId) return { kind: "none" };
  return { kind: "move", id: source.id, folderId: targetFolderId };
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
  // `folderId`/`folderName` (#118) pré-scopent l'ajout au dossier (« + » de son
  // en-tête) ; absents = ajout « sans dossier » (« + » de la section Flux).
  | { kind: "addFeed"; folderId?: string | null; folderName?: string }
  | { kind: "createFolder" }
  | { kind: "renameFolder"; folder: Folder }
  | { kind: "renameFeed"; feed: Feed }
  | { kind: "deleteFolder"; folder: Folder }
  | { kind: "unsubscribeFeed"; feed: Feed };
