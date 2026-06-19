import {
  DragDropProvider,
  type DragEndEvent,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
} from "@dnd-kit/react";
import { isSortable } from "@dnd-kit/react/sortable";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { articleCountsQueryOptions } from "../lib/articles";
import { feedsQueryOptions } from "../lib/feeds";
import { foldersQueryOptions } from "../lib/folders";
import { useOnlineStatus } from "../lib/use-online-status";
import { OfflineStatus } from "./OfflineStatus";
import { FolderTree } from "./sidebar/FolderTree";
import {
  computeFolderRank,
  FOLDER_DRAG_TYPE,
  type FolderDragData,
} from "./sidebar/folder-reorder";
import { SidebarDialogs } from "./sidebar/SidebarDialogs";
import { SidebarSearch } from "./sidebar/SidebarSearch";
import {
  type FeedDragData,
  type FeedDragSource,
  groupFeedsByFolder,
  resolveDropTarget,
  resolveFeedDragEnd,
  type SidebarDialog,
} from "./sidebar/sidebar-model";
import { useFeedLifecycle } from "./sidebar/use-feed-lifecycle";
import { useFeedMoveAndRank } from "./sidebar/use-feed-move-and-rank";
import { useFeedReorder } from "./sidebar/use-feed-reorder";
import { useFolderReorder } from "./sidebar/use-folder-reorder";
import { CountBadge } from "./ui/Badge";
import { BrandLogo } from "./ui/BrandLogo";

const itemBase =
  "flex min-h-11 w-full items-center gap-2 rounded-card px-3 text-left text-sm transition-colors hover:bg-surface-2";
const itemActive = "bg-surface-2 font-medium text-accent";

/**
 * Sensors du drag-n-drop des Feeds. Le `PointerSensor` conserve ses seuils
 * d'activation par défaut (souris : 5px / délai ; tactile : long-press 250ms) —
 * ils distinguent le clic (→ navigation via le `Link`) du drag et préservent le
 * scroll du drawer mobile.
 *
 * `preventActivation` par défaut interdit le drag dès qu'on presse un élément
 * interactif imbriqué (y compris le `<Link>` du feed) : il bloquerait donc tout
 * drag, la ligne étant essentiellement un lien. On le restreint aux **boutons**
 * (menu kebab, entrées de menu) pour qu'ils restent cliquables sans armer de
 * drag, tout en laissant le reste de la ligne — lien compris — déclencher le
 * drag. `KeyboardSensor` rend le déplacement opérable au clavier (a11y).
 */
const dragSensors = [
  PointerSensor.configure({
    preventActivation: (event) =>
      event.target instanceof Element &&
      event.target.closest("button") !== null,
  }),
  KeyboardSensor,
];

/**
 * Colonne de navigation : marque, vues globales, Folders/Feeds, thème, réglages
 * (#48). Composition mince de seams testables : `FolderTree` rend les sections,
 * `SidebarDialogs` les dialogues pilotés par l'union `SidebarDialog`, et
 * `useFeedLifecycle` porte la navigation après désabonnement/suppression.
 */
export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  // Un seul dialogue ouvert à la fois (`null` = aucun), cf. `SidebarDialog`.
  const [dialog, setDialog] = useState<SidebarDialog | null>(null);

  // Compteur global de non-lus exact (#8) + agrégats par feed et par folder (#13).
  const counts = useQuery(articleCountsQueryOptions());
  const feeds = useQuery(feedsQueryOptions());
  const folders = useQuery(foldersQueryOptions());

  // Requête de recherche courante (#73) : reflète `?q` quand on est sur `/search`,
  // sinon vide. `strict: false` : la sidebar est montée hors d'une route précise.
  const { q: searchQuery } = useSearch({ strict: false }) as { q?: string };

  // Ops Feeds/Folders **online-only** (ADR 0018) : ajouter/déplacer/renommer/
  // supprimer/désabonner exigent le réseau. Hors-ligne, on les désactive
  // visiblement (cf. `FolderTree`/`FeedRow`/`SidebarDialogs` + drag-drop ci-dessous).
  const online = useOnlineStatus();

  const lifecycle = useFeedLifecycle();
  const folderReorder = useFolderReorder();
  const feedReorder = useFeedReorder();
  const feedMoveAndRank = useFeedMoveAndRank();

  const unreadByFeed = useMemo(
    () => new Map(counts.data?.byFeed.map((f) => [f.feedId, f.count])),
    [counts.data],
  );
  const unreadByFolder = useMemo(
    () => new Map(counts.data?.byFolder.map((f) => [f.folderId, f.count])),
    [counts.data],
  );

  const foldersData = folders.data ?? [];
  const feedsData = feeds.data ?? [];

  const { feedsByFolder, unfiledFeeds } = useMemo(
    () => groupFeedsByFolder(foldersData, feedsData),
    [foldersData, feedsData],
  );

  // Liste **triée** des Feeds d'un conteneur (Folder ou zone « sans dossier »),
  // telle que rendue dans la sidebar : c'est sur ses index que `computeFeedRank`
  // raisonne. `null` = zone sans dossier. Le tri vient de `GET /api/feeds`
  // (`ORDER BY folder_id, rank, id`), préservé par `groupFeedsByFolder`.
  function feedsInContainer(folderId: string | null) {
    return folderId === null
      ? unfiledFeeds
      : (feedsByFolder.get(folderId) ?? []);
  }

  // Fin de drag : on route selon la **source** (#109/#111/#112). Source dossier
  // (`FOLDER_DRAG_TYPE`) → réordonnancement entre dossiers (#109). Source Feed :
  // si le conteneur n'a pas changé (`initialGroup === group`, dnd-kit projette le
  // group de la cible sur le sortable) → **réordonnancement intra-conteneur**
  // (#111, `computeFeedRank`) ; si le conteneur change sur un sortable (group
  // projeté + index) → **déplacement à position précise** (#112,
  // `move-and-rank`, un PATCH `{folderId, rank}` atomique) ; en repli (en-tête
  // dossier non-sortable) → **déplacement simple** vers un autre Folder /
  // désassignation (chemin #13). On ignore l'annulation et les drops hors cible.
  // **Online-only** (ADR 0018) : hors-ligne, on no-op (drag aussi désactivé).
  function handleDragEnd(event: DragEndEvent) {
    if (!online) return;
    const { source, target } = event.operation;
    if (event.canceled || !source) return;

    if (source.type === FOLDER_DRAG_TYPE && isSortable(source)) {
      // Index avant/après dans la liste triée, fournis par dnd-kit (sortable) :
      // `initialIndex` = position au début du drag, `index` = position projetée à
      // la dépose. Le rang est calculé sur la liste réordonnée puis persisté.
      const rank = computeFolderRank(
        foldersData,
        source.initialIndex,
        source.index,
      );
      if (rank === null) return;
      folderReorder.reorder(String(source.id), rank);
      return;
    }

    // Chemin Feed : `resolveFeedDragEnd` (pur, testé) discrimine
    // réordonnancement intra-conteneur (#111) et déplacement (#13). On lui passe
    // une vue découplée des types dnd-kit. `target` (dossier ou zone « sans
    // dossier ») sert au move ; `undefined` = drop hors zone.
    const data = source.data as FeedDragData | undefined;
    const dragSource: FeedDragSource = isSortable(source)
      ? {
          id: String(source.id),
          isSortable: true,
          initialGroup:
            source.initialGroup === undefined
              ? undefined
              : String(source.initialGroup),
          group: source.group === undefined ? undefined : String(source.group),
          initialIndex: source.initialIndex,
          index: source.index,
          folderId: data?.folderId ?? null,
        }
      : {
          id: String(source.id),
          isSortable: false,
          folderId: data?.folderId ?? null,
        };
    const targetFolderId = target
      ? resolveDropTarget(String(target.id))
      : undefined;

    const action = resolveFeedDragEnd(
      dragSource,
      targetFolderId,
      feedsInContainer,
    );
    if (action.kind === "reorder") feedReorder.reorder(action.id, action.rank);
    else if (action.kind === "move-and-rank")
      feedMoveAndRank.moveAndRank(action.id, action.folderId, action.rank);
    else if (action.kind === "move") lifecycle.move(action.id, action.folderId);
  }

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex h-14 items-center px-4">
        <BrandLogo />
      </div>

      <SidebarSearch initialQuery={searchQuery ?? ""} onNavigate={onNavigate} />

      <DragDropProvider sensors={dragSensors} onDragEnd={handleDragEnd}>
        <nav className="flex-1 space-y-1 overflow-y-auto px-2 pb-2">
          <Link
            to="/"
            activeOptions={{ exact: true }}
            onClick={onNavigate}
            className={itemBase}
            activeProps={{ className: itemActive }}
          >
            <span aria-hidden>📥</span>
            <span>Tous les non-lus</span>
            <CountBadge count={counts.data?.total ?? 0} className="ml-auto" />
          </Link>
          <Link
            to="/saved"
            onClick={onNavigate}
            className={itemBase}
            activeProps={{ className: itemActive }}
          >
            <span aria-hidden>★</span>
            <span>Saved</span>
          </Link>

          <FolderTree
            folders={foldersData}
            feedsByFolder={feedsByFolder}
            unfiledFeeds={unfiledFeeds}
            feedsCount={feedsData.length}
            unreadByFeed={unreadByFeed}
            unreadByFolder={unreadByFolder}
            onRequestDialog={setDialog}
            onNavigate={onNavigate}
            online={online}
          />
        </nav>

        {/* Fantôme suivant le curseur pendant le drag : libellé du Feed (déplacement)
            ou nom du dossier (réordonnancement, #109), selon le type de la source. */}
        <DragOverlay>
          {(source) => {
            const label =
              source.type === FOLDER_DRAG_TYPE
                ? (source.data as FolderDragData | undefined)?.name
                : (source.data as FeedDragData | undefined)?.label;
            if (label === undefined) return null;
            return (
              <div className={`${itemBase} bg-surface text-text shadow-pop`}>
                <span className="truncate">{label}</span>
              </div>
            );
          }}
        </DragOverlay>
      </DragDropProvider>

      <SidebarDialogs
        dialog={dialog}
        onClose={() => setDialog(null)}
        unsubscribe={lifecycle.unsubscribe}
        online={online}
      />

      {/* Indicateur de connexion + badge « actions en attente » (#81). */}
      <OfflineStatus />

      <div className="border-border border-t p-3">
        <Link
          to="/settings"
          onClick={onNavigate}
          className={itemBase}
          activeProps={{ className: itemActive }}
        >
          <span aria-hidden>⚙</span>
          <span>Réglages</span>
        </Link>
      </div>
    </div>
  );
}
