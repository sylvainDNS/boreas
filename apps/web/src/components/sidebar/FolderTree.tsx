import { useDroppable } from "@dnd-kit/react";
import { Link, useMatchRoute } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import type { Feed } from "../../lib/feeds";
import type { Folder } from "../../lib/folders";
import { menuItemClass, RowMenu } from "../RowMenu";
import { CountBadge } from "../ui/Badge";
import { FeedRow } from "./FeedRow";
import {
  FEED_DRAG_TYPE,
  itemActive,
  itemBase,
  type SidebarDialog,
  UNFILED_DROPPABLE_ID,
} from "./sidebar-model";

/** Surbrillance d'une zone de drop survolée par un Feed en cours de drag. */
const dropTargetClass = "rounded-card ring-2 ring-accent ring-inset";

/**
 * Sections « Dossiers » et « Flux (sans dossier) » de la Sidebar (#48). Porte
 * l'état local des dossiers repliés (`collapsed`) et les états vides. Délègue
 * chaque ligne Feed à `FeedRow` et chaque action à `onRequestDialog`/`onMove` ;
 * ne touche ni aux mutations ni au router. Chaque dossier et la zone « sans
 * dossier » sont des cibles de drop — déléguées à `FolderDroppable` et au
 * droppable de section ci-dessous.
 */
export function FolderTree({
  folders,
  feedsByFolder,
  unfiledFeeds,
  feedsCount,
  unreadByFeed,
  unreadByFolder,
  onRequestDialog,
  onMove,
  onNavigate,
}: {
  folders: readonly Folder[];
  feedsByFolder: ReadonlyMap<string, Feed[]>;
  unfiledFeeds: readonly Feed[];
  /** Total des feeds (toutes sections) : pilote l'état vide global. */
  feedsCount: number;
  unreadByFeed: ReadonlyMap<string, number>;
  unreadByFolder: ReadonlyMap<string, number>;
  onRequestDialog: (dialog: SidebarDialog) => void;
  onMove: (id: string, folderId: string | null) => void;
  onNavigate?: () => void;
}) {
  // Folders repliés (par défaut tous dépliés : un id présent = replié).
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  function toggleCollapse(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function renderFeed(feed: Feed) {
    return (
      <FeedRow
        key={feed.id}
        feed={feed}
        unread={unreadByFeed.get(feed.id) ?? 0}
        folders={folders}
        onRequestDialog={onRequestDialog}
        onMove={onMove}
        onNavigate={onNavigate}
      />
    );
  }

  return (
    <>
      {/* Section Dossiers (#13) : groupes dépliables, chacun cible de drop. */}
      <div className="pt-3">
        <div className="flex items-center justify-between px-3 pb-1">
          <p className="font-semibold text-[0.7rem] text-muted uppercase tracking-wide">
            Dossiers
          </p>
          <button
            type="button"
            onClick={() => onRequestDialog({ kind: "createFolder" })}
            aria-label="Nouveau dossier"
            title="Nouveau dossier"
            className="rounded-card px-1.5 text-base text-muted leading-none transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
          >
            +
          </button>
        </div>
        {folders.map((folder) => (
          <FolderDroppable
            key={folder.id}
            folder={folder}
            feeds={feedsByFolder.get(folder.id) ?? []}
            isExpanded={!collapsed.has(folder.id)}
            unread={unreadByFolder.get(folder.id) ?? 0}
            onToggle={() => toggleCollapse(folder.id)}
            onRequestDialog={onRequestDialog}
            onNavigate={onNavigate}
            renderFeed={renderFeed}
          />
        ))}
        {folders.length === 0 && (
          <p className="px-3 py-1 text-muted text-sm">Aucun dossier.</p>
        )}
      </div>

      {/* Section Flux : feeds sans dossier + cible de drop « désassigner ». */}
      <UnfiledDroppable>
        <div className="flex items-center justify-between px-3 pb-1">
          <p className="font-semibold text-[0.7rem] text-muted uppercase tracking-wide">
            {folders.length > 0 ? "Flux (sans dossier)" : "Flux"}
          </p>
          <button
            type="button"
            onClick={() => onRequestDialog({ kind: "addFeed" })}
            aria-label="Ajouter un flux"
            title="Ajouter un flux"
            className="rounded-card px-1.5 text-base text-muted leading-none transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
          >
            +
          </button>
        </div>
        {unfiledFeeds.map(renderFeed)}
        {feedsCount === 0 && (
          <div className="px-3 py-1">
            <p className="text-muted text-sm">Aucun flux pour l'instant.</p>
            <button
              type="button"
              onClick={() => onRequestDialog({ kind: "addFeed" })}
              className="mt-1 text-accent text-sm underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent"
            >
              Ajouter un flux
            </button>
          </div>
        )}
      </UnfiledDroppable>
    </>
  );
}

/**
 * Un dossier : en-tête (repli/dépli, lien, compteur, menu) + ses feeds dépliés,
 * le tout formant **une seule zone de drop** (`accept: feed`). Composant
 * dédié car `useDroppable` est un hook : un hook par dossier rendu, jamais dans
 * une fonction appelée en boucle. Lâcher un Feed ici le déplace dans ce dossier.
 */
function FolderDroppable({
  folder,
  feeds,
  isExpanded,
  unread,
  onToggle,
  onRequestDialog,
  onNavigate,
  renderFeed,
}: {
  folder: Folder;
  feeds: readonly Feed[];
  isExpanded: boolean;
  unread: number;
  onToggle: () => void;
  onRequestDialog: (dialog: SidebarDialog) => void;
  onNavigate?: () => void;
  renderFeed: (feed: Feed) => ReactNode;
}) {
  const matchRoute = useMatchRoute();
  const isActive = Boolean(
    matchRoute({ to: "/folders/$folderId", params: { folderId: folder.id } }),
  );
  const { ref, isDropTarget } = useDroppable({
    id: folder.id,
    accept: FEED_DRAG_TYPE,
  });

  return (
    <div ref={ref} className={isDropTarget ? dropTargetClass : undefined}>
      <div className={`group ${itemBase} ${isActive ? itemActive : ""}`}>
        <button
          type="button"
          aria-label={isExpanded ? "Replier le dossier" : "Déplier le dossier"}
          aria-expanded={isExpanded}
          onClick={onToggle}
          className="grid size-5 shrink-0 place-items-center rounded text-muted text-xs hover:text-text"
        >
          {isExpanded ? "▾" : "▸"}
        </button>
        <Link
          to="/folders/$folderId"
          params={{ folderId: folder.id }}
          onClick={onNavigate}
          className="flex min-w-0 flex-1 items-center gap-2"
        >
          <span aria-hidden>📁</span>
          <span className="truncate">{folder.name}</span>
        </Link>
        <CountBadge count={unread} />
        <RowMenu
          label={`Actions pour ${folder.name}`}
          triggerClassName="opacity-60 transition-opacity group-hover:opacity-100"
        >
          {(close) => (
            <>
              <button
                type="button"
                role="menuitem"
                className={menuItemClass}
                onClick={() => {
                  close();
                  onRequestDialog({ kind: "renameFolder", folder });
                }}
              >
                Renommer…
              </button>
              <button
                type="button"
                role="menuitem"
                className={`${menuItemClass} text-danger`}
                onClick={() => {
                  close();
                  onRequestDialog({ kind: "deleteFolder", folder });
                }}
              >
                Supprimer
              </button>
            </>
          )}
        </RowMenu>
      </div>
      {isExpanded && (
        <div className="ml-4 space-y-1 border-border border-l pl-1">
          {feeds.map(renderFeed)}
          {feeds.length === 0 && (
            <p className="px-3 py-1 text-muted text-xs">Dossier vide.</p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Zone « Flux (sans dossier) » comme cible de drop : lâcher un Feed ici le
 * désassigne (`folderId = null`, via la sentinelle `UNFILED_DROPPABLE_ID` que
 * `resolveDropTarget` retraduit). Composant dédié pour le hook `useDroppable`.
 */
function UnfiledDroppable({ children }: { children: ReactNode }) {
  const { ref, isDropTarget } = useDroppable({
    id: UNFILED_DROPPABLE_ID,
    accept: FEED_DRAG_TYPE,
  });
  return (
    <div ref={ref} className={`pt-3 ${isDropTarget ? dropTargetClass : ""}`}>
      {children}
    </div>
  );
}
