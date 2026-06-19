import { useSortable } from "@dnd-kit/react/sortable";
import { Link, useMatchRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { type Feed, feedLabel } from "../../lib/feeds";
import { menuItemClass, RowMenu, rowMenuTriggerClass } from "../RowMenu";
import { ErrorBadge, UnreadDot } from "../ui/Badge";
import { useRowMenu } from "../useRowMenu";
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
  index,
  group,
  unread,
  onRequestDialog,
  onNavigate,
  online,
}: {
  feed: Feed;
  /** Position du Feed dans la liste **triée** de son conteneur (#111). */
  index: number;
  /** Identité du conteneur sortable (id du Folder, ou sentinelle « sans dossier »). */
  group: string;
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
  const menu = useRowMenu();

  // Sortable (#111) : le Feed est à la fois *source* d'un réordonnancement
  // **intra-conteneur** (même `group`) et d'un déplacement **inter-conteneur**
  // (#13, group différent à la dépose) ; il reste *cible* d'un autre Feed
  // (`accept: FEED_DRAG_TYPE`). `onDragEnd` (Sidebar) discrimine reorder/move sur
  // `source.initialGroup` vs `source.group`. Le seuil du PointerSensor (cf.
  // Sidebar) distingue clic (navigation via le Link) et drag ; `data` porte le
  // folderId courant + le libellé du fantôme. Identité mémoïsée sur des
  // primitives : dnd-kit compare `data` par `Object.is` et réassigne le signal à
  // chaque changement — sans ça, chaque render (poll 30s, route) le réécrirait.
  const dragData = useMemo<FeedDragData>(
    () => ({ folderId: feed.folderId, label }),
    [feed.folderId, label],
  );
  const { ref, isDragSource } = useSortable<FeedDragData>({
    id: feed.id,
    index,
    group,
    type: FEED_DRAG_TYPE,
    accept: FEED_DRAG_TYPE,
    data: dragData,
    // Réordonnancement/déplacement = ops online-only (ADR 0018) : hors-ligne, le
    // drag est désactivé (et `onDragEnd` no-op en secours).
    disabled: !online,
  });

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: clic droit / Shift+F10 sur toute la ligne ne sont qu'une commodité ; l'accès clavier passe par le bouton déclencheur focalisable (#114).
    <div
      ref={ref}
      onContextMenu={menu.onContextMenu}
      onKeyDown={menu.onKeyDown}
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
      {/* Plus de kebab permanent (#114) : déclencheur révélé au focus clavier
          (ligne ou bouton), invisible au repos. Clic droit / Shift+F10 / touche
          Menu ouvrent le même menu via `useRowMenu`. */}
      <button
        type="button"
        {...menu.triggerProps}
        aria-label={`Actions pour ${label}`}
        title={`Actions pour ${label}`}
        className={rowMenuTriggerClass}
      >
        ⋯
      </button>
      {menu.position && (
        <RowMenu
          label={`Actions pour ${label}`}
          position={menu.position}
          onClose={menu.close}
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
      )}
    </div>
  );
}
