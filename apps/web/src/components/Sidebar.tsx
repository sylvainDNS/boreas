import {
  DragDropProvider,
  type DragEndEvent,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
} from "@dnd-kit/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { articleCountsQueryOptions } from "../lib/articles";
import { AUTH_QUERY_KEY, logout } from "../lib/auth";
import { feedsQueryOptions } from "../lib/feeds";
import { foldersQueryOptions } from "../lib/folders";
import { useOnlineStatus } from "../lib/use-online-status";
import { OfflineStatus } from "./OfflineStatus";
import { FolderTree } from "./sidebar/FolderTree";
import { SidebarDialogs } from "./sidebar/SidebarDialogs";
import { SidebarSearch } from "./sidebar/SidebarSearch";
import {
  type FeedDragData,
  groupFeedsByFolder,
  resolveDropTarget,
  type SidebarDialog,
} from "./sidebar/sidebar-model";
import { useFeedLifecycle } from "./sidebar/use-feed-lifecycle";
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
  const navigate = useNavigate();
  const queryClient = useQueryClient();

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

  async function handleLogout() {
    await logout();
    queryClient.setQueryData(AUTH_QUERY_KEY, false);
    onNavigate?.();
    await navigate({ to: "/login" });
  }

  // Fin de drag : un Feed (source) lâché sur un dossier ou la zone « sans
  // dossier » (target). On ignore l'annulation et les drops hors cible, et on
  // court-circuite un drop sur le dossier courant (no-op). `move` est optimiste.
  // **Online-only** (ADR 0018) : hors-ligne, on no-op (le drag est aussi
  // désactivé côté `FeedRow`, ceci est une double sécurité).
  function handleDragEnd(event: DragEndEvent) {
    if (!online) return;
    const { source, target } = event.operation;
    if (event.canceled || !source || !target) return;
    const targetFolderId = resolveDropTarget(String(target.id));
    const data = source.data as FeedDragData | undefined;
    if (data?.folderId === targetFolderId) return;
    lifecycle.move(String(source.id), targetFolderId);
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

        {/* Fantôme suivant le curseur pendant le drag : libellé du Feed. */}
        <DragOverlay>
          {(source) => {
            const data = source.data as FeedDragData | undefined;
            if (!data) return null;
            return (
              <div className={`${itemBase} bg-surface text-text shadow-pop`}>
                <span className="truncate">{data.label}</span>
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

      <div className="space-y-2 border-border border-t p-3">
        <Link
          to="/settings"
          onClick={onNavigate}
          className={itemBase}
          activeProps={{ className: itemActive }}
        >
          <span aria-hidden>⚙</span>
          <span>Réglages</span>
        </Link>
        <button type="button" onClick={handleLogout} className={itemBase}>
          <span aria-hidden>⎋</span>
          <span>Se déconnecter</span>
        </button>
      </div>
    </div>
  );
}
