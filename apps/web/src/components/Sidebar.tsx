import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { AUTH_QUERY_KEY, logout } from "../lib/auth";
import { folders, totalUnread } from "../mock";
import { ThemeToggle } from "./ThemeToggle";
import { CountBadge } from "./ui/Badge";
import { BrandLogo } from "./ui/BrandLogo";

const itemBase =
  "flex min-h-11 w-full items-center gap-2 rounded-card px-3 text-left text-sm transition-colors hover:bg-surface-2";
const itemActive = "bg-surface-2 font-medium text-accent";

/** Colonne de navigation : marque, vues globales, Folders/Feeds, thème, réglages. */
export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  async function handleLogout() {
    await logout();
    // Marque la session comme expirée puis renvoie vers /login.
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
          <CountBadge count={totalUnread} className="ml-auto" />
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

        {folders.map((folder) => (
          <div key={folder.id} className="pt-3">
            <Link
              to="/folders/$folderId"
              params={{ folderId: folder.id }}
              onClick={onNavigate}
              className="flex items-center px-3 pb-1 font-semibold text-[0.7rem] text-muted uppercase tracking-wide hover:text-text"
              activeProps={{ className: "text-accent" }}
            >
              {folder.name}
            </Link>
            {folder.feeds.map((feed) => (
              <Link
                key={feed.id}
                to="/feeds/$feedId"
                params={{ feedId: feed.id }}
                onClick={onNavigate}
                className={itemBase}
                activeProps={{ className: itemActive }}
              >
                <span className="size-1.5 shrink-0 rounded-full bg-muted/40" />
                <span className="truncate">{feed.name}</span>
                <CountBadge count={feed.unread} className="ml-auto" />
              </Link>
            ))}
          </div>
        ))}
      </nav>

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
