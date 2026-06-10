import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { articleCountsQueryOptions } from "../lib/articles";
import { AUTH_QUERY_KEY, logout } from "../lib/auth";
import { feedsQueryOptions } from "../lib/feeds";
import { foldersQueryOptions } from "../lib/folders";
import { FolderTree } from "./sidebar/FolderTree";
import { SidebarDialogs } from "./sidebar/SidebarDialogs";
import {
  groupFeedsByFolder,
  type SidebarDialog,
} from "./sidebar/sidebar-model";
import { useFeedLifecycle } from "./sidebar/use-feed-lifecycle";
import { ThemeToggle } from "./ThemeToggle";
import { CountBadge } from "./ui/Badge";
import { BrandLogo } from "./ui/BrandLogo";

const itemBase =
  "flex min-h-11 w-full items-center gap-2 rounded-card px-3 text-left text-sm transition-colors hover:bg-surface-2";
const itemActive = "bg-surface-2 font-medium text-accent";

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

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex h-14 items-center px-4">
        <BrandLogo />
      </div>

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
          onMove={lifecycle.move}
          onNavigate={onNavigate}
        />
      </nav>

      <SidebarDialogs
        dialog={dialog}
        onClose={() => setDialog(null)}
        unsubscribe={lifecycle.unsubscribe}
        remove={lifecycle.remove}
      />

      <div className="space-y-2 border-border border-t p-3">
        <ThemeToggle />
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
