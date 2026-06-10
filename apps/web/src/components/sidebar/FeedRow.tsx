import { Link, useMatchRoute } from "@tanstack/react-router";
import { type Feed, feedLabel } from "../../lib/feeds";
import type { Folder } from "../../lib/folders";
import { MenuLabel, menuItemClass, RowMenu } from "../RowMenu";
import { CountBadge, ErrorBadge } from "../ui/Badge";
import { itemActive, itemBase, type SidebarDialog } from "./sidebar-model";

/**
 * Ligne d'un Feed dans la Sidebar (#48). État actif dérivé de la route
 * (`useMatchRoute`) ; badges existants (erreur, non-lus). Le menu n'agit pas
 * lui-même : il **demande** un dialogue (`onRequestDialog`) ou un déplacement
 * (`onMove`), laissant la composition pilote l'état des dialogues et le router.
 */
export function FeedRow({
  feed,
  unread,
  folders,
  onRequestDialog,
  onMove,
  onNavigate,
}: {
  feed: Feed;
  unread: number;
  folders: readonly Folder[];
  onRequestDialog: (dialog: SidebarDialog) => void;
  onMove: (id: string, folderId: string | null) => void;
  onNavigate?: () => void;
}) {
  const matchRoute = useMatchRoute();
  const isActive = Boolean(
    matchRoute({ to: "/feeds/$feedId", params: { feedId: feed.id } }),
  );

  return (
    <div className={`group ${itemBase} ${isActive ? itemActive : ""}`}>
      <Link
        to="/feeds/$feedId"
        params={{ feedId: feed.id }}
        onClick={onNavigate}
        className="flex min-w-0 flex-1 items-center gap-2"
      >
        <span className="size-1.5 shrink-0 rounded-full bg-muted/40" />
        <span className="truncate">{feedLabel(feed)}</span>
      </Link>
      {feed.status === "error" && <ErrorBadge detail={feed.lastError} />}
      <CountBadge count={unread} />
      <RowMenu
        label={`Actions pour ${feedLabel(feed)}`}
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
                onRequestDialog({ kind: "renameFeed", feed });
              }}
            >
              Renommer…
            </button>
            <MenuLabel>Déplacer vers</MenuLabel>
            <button
              type="button"
              role="menuitem"
              className={menuItemClass}
              disabled={feed.folderId == null}
              onClick={() => {
                close();
                onMove(feed.id, null);
              }}
            >
              Aucun dossier {feed.folderId == null ? "✓" : ""}
            </button>
            {folders.map((folder) => (
              <button
                key={folder.id}
                type="button"
                role="menuitem"
                className={menuItemClass}
                disabled={feed.folderId === folder.id}
                onClick={() => {
                  close();
                  onMove(feed.id, folder.id);
                }}
              >
                <span className="truncate">{folder.name}</span>
                {feed.folderId === folder.id ? " ✓" : ""}
              </button>
            ))}
            <div className="my-1 border-border border-t" />
            <button
              type="button"
              role="menuitem"
              className={menuItemClass}
              onClick={() => {
                close();
                onRequestDialog({ kind: "unsubscribeFeed", feed });
              }}
            >
              Se désabonner
            </button>
            <button
              type="button"
              role="menuitem"
              className={`${menuItemClass} text-danger`}
              onClick={() => {
                close();
                onRequestDialog({ kind: "deleteFeed", feed });
              }}
            >
              Supprimer…
            </button>
          </>
        )}
      </RowMenu>
    </div>
  );
}
