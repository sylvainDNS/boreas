import { useDraggable } from "@dnd-kit/react";
import { Link, useMatchRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { type Feed, feedLabel } from "../../lib/feeds";
import { menuItemClass, RowMenu } from "../RowMenu";
import { ErrorBadge, UnreadDot } from "../ui/Badge";
import {
  FEED_DRAG_TYPE,
  type FeedDragData,
  itemActive,
  itemBase,
  OFFLINE_OP_TITLE,
  type SidebarDialog,
  unreadNameClass,
} from "./sidebar-model";

/**
 * Ligne d'un Feed dans la Sidebar (#48). État actif dérivé de la route
 * (`useMatchRoute`) ; badges existants (erreur, non-lus). Le menu n'agit pas
 * lui-même : il **demande** un dialogue (`onRequestDialog`), laissant la
 * composition piloter l'état des dialogues et le router. Le déplacement passe
 * uniquement par le drag-n-drop (#113 : menu réduit à Renommer + Se désabonner).
 */
export function FeedRow({
  feed,
  unread,
  onRequestDialog,
  onNavigate,
  online,
}: {
  feed: Feed;
  unread: number;
  onRequestDialog: (dialog: SidebarDialog) => void;
  onNavigate?: () => void;
  /** Connexion réseau : drag et actions cycle de vie gatés. */
  online: boolean;
}) {
  const matchRoute = useMatchRoute();
  const isActive = Boolean(
    matchRoute({ to: "/feeds/$feedId", params: { feedId: feed.id } }),
  );
  const label = feedLabel(feed);

  // Draggable vers les dossiers / la zone « sans dossier ». Le seuil
  // d'activation du PointerSensor (cf. Sidebar) distingue le clic (navigation via
  // le Link) du drag ; `data` porte le folderId courant + le libellé du fantôme.
  // Identité mémoïsée sur des primitives : dnd-kit compare `data` par `Object.is`
  // et réassigne le signal du draggable à chaque changement — sans ça, chaque
  // render (poll 30s, changement de route) le réécrirait inutilement.
  const dragData = useMemo<FeedDragData>(
    () => ({ folderId: feed.folderId, label }),
    [feed.folderId, label],
  );
  const { ref, isDragSource } = useDraggable<FeedDragData>({
    id: feed.id,
    type: FEED_DRAG_TYPE,
    data: dragData,
    // Déplacement = op online-only (ADR 0018) : hors-ligne, le drag est désactivé
    // (et `onDragEnd` no-op en secours).
    disabled: !online,
  });

  return (
    <div
      ref={ref}
      className={`group ${itemBase} ${isActive ? itemActive : ""} ${
        isDragSource ? "opacity-50" : ""
      }`}
    >
      <Link
        to="/feeds/$feedId"
        params={{ feedId: feed.id }}
        onClick={onNavigate}
        className="flex min-w-0 flex-1 items-center gap-2"
      >
        <span className={`truncate ${unreadNameClass(unread > 0)}`}>
          {label}
        </span>
      </Link>
      {feed.status === "error" && <ErrorBadge detail={feed.lastError} />}
      <UnreadDot hasUnread={unread > 0} />
      <RowMenu
        label={`Actions pour ${label}`}
        triggerClassName="opacity-60 transition-opacity group-hover:opacity-100"
      >
        {(close) => (
          <>
            <button
              type="button"
              role="menuitem"
              disabled={!online}
              title={online ? undefined : OFFLINE_OP_TITLE}
              className={menuItemClass}
              onClick={() => {
                close();
                onRequestDialog({ kind: "renameFeed", feed });
              }}
            >
              Renommer…
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!online}
              title={online ? undefined : OFFLINE_OP_TITLE}
              className={menuItemClass}
              onClick={() => {
                close();
                onRequestDialog({ kind: "unsubscribeFeed", feed });
              }}
            >
              Se désabonner
            </button>
          </>
        )}
      </RowMenu>
    </div>
  );
}
