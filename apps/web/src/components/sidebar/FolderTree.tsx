import { Link, useMatchRoute } from "@tanstack/react-router";
import { useState } from "react";
import type { Feed } from "../../lib/feeds";
import type { Folder } from "../../lib/folders";
import { menuItemClass, RowMenu } from "../RowMenu";
import { CountBadge } from "../ui/Badge";
import { FeedRow } from "./FeedRow";
import { itemActive, itemBase, type SidebarDialog } from "./sidebar-model";

/**
 * Sections « Dossiers » et « Flux (sans dossier) » de la Sidebar (#48). Porte
 * l'état local des dossiers repliés (`collapsed`) et les états vides. Délègue
 * chaque ligne Feed à `FeedRow` et chaque action à `onRequestDialog`/`onMove` ;
 * ne touche ni aux mutations ni au router.
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
  const matchRoute = useMatchRoute();
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

  function renderFolder(folder: Folder) {
    const isExpanded = !collapsed.has(folder.id);
    const folderFeeds = feedsByFolder.get(folder.id) ?? [];
    const isActive = Boolean(
      matchRoute({ to: "/folders/$folderId", params: { folderId: folder.id } }),
    );
    return (
      <div key={folder.id}>
        <div className={`group ${itemBase} ${isActive ? itemActive : ""}`}>
          <button
            type="button"
            aria-label={
              isExpanded ? "Replier le dossier" : "Déplier le dossier"
            }
            aria-expanded={isExpanded}
            onClick={() => toggleCollapse(folder.id)}
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
          <CountBadge count={unreadByFolder.get(folder.id) ?? 0} />
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
            {folderFeeds.map(renderFeed)}
            {folderFeeds.length === 0 && (
              <p className="px-3 py-1 text-muted text-xs">Dossier vide.</p>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      {/* Section Dossiers (#13) : groupes dépliables. */}
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
        {folders.map(renderFolder)}
        {folders.length === 0 && (
          <p className="px-3 py-1 text-muted text-sm">Aucun dossier.</p>
        )}
      </div>

      {/* Section Flux : uniquement les feeds sans dossier. */}
      <div className="pt-3">
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
      </div>
    </>
  );
}
