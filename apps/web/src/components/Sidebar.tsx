import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { articleCountsQueryOptions } from "../lib/articles";
import { AUTH_QUERY_KEY, logout } from "../lib/auth";
import { feedLabel, feedsQueryOptions } from "../lib/feeds";
import { AddFeedDialog } from "./AddFeedDialog";
import { ThemeToggle } from "./ThemeToggle";
import { CountBadge, ErrorBadge } from "./ui/Badge";
import { BrandLogo } from "./ui/BrandLogo";

const itemBase =
  "flex min-h-11 w-full items-center gap-2 rounded-card px-3 text-left text-sm transition-colors hover:bg-surface-2";
const itemActive = "bg-surface-2 font-medium text-accent";

/** Colonne de navigation : marque, vues globales, Folders/Feeds, thème, réglages. */
export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [addFeedOpen, setAddFeedOpen] = useState(false);
  // Compteur global de non-lus exact (#8) + agrégat par feed pour les pastilles.
  const counts = useQuery(articleCountsQueryOptions());
  // Liste réelle des feeds avec leur santé (#11). La réorganisation en folders
  // reste #13 : on rend ici une liste plate.
  const feeds = useQuery(feedsQueryOptions());
  // Recalculée seulement quand les compteurs changent (pas à chaque re-render).
  const unreadByFeed = useMemo(
    () => new Map(counts.data?.byFeed.map((f) => [f.feedId, f.count])),
    [counts.data],
  );

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

        <div className="pt-3">
          <div className="flex items-center justify-between px-3 pb-1">
            <p className="font-semibold text-[0.7rem] text-muted uppercase tracking-wide">
              Flux
            </p>
            <button
              type="button"
              onClick={() => setAddFeedOpen(true)}
              aria-label="Ajouter un flux"
              title="Ajouter un flux"
              className="rounded-card px-1.5 text-base text-muted leading-none transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
            >
              +
            </button>
          </div>
          {feeds.data?.map((feed) => (
            <Link
              key={feed.id}
              to="/feeds/$feedId"
              params={{ feedId: feed.id }}
              onClick={onNavigate}
              className={itemBase}
              activeProps={{ className: itemActive }}
            >
              <span className="size-1.5 shrink-0 rounded-full bg-muted/40" />
              <span className="truncate">{feedLabel(feed)}</span>
              <span className="ml-auto flex items-center gap-1">
                {feed.status === "error" && (
                  <ErrorBadge detail={feed.lastError} />
                )}
                <CountBadge count={unreadByFeed.get(feed.id) ?? 0} />
              </span>
            </Link>
          ))}
          {feeds.data?.length === 0 && (
            <div className="px-3 py-1">
              <p className="text-muted text-sm">Aucun flux pour l'instant.</p>
              <button
                type="button"
                onClick={() => setAddFeedOpen(true)}
                className="mt-1 text-accent text-sm underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent"
              >
                Ajouter un flux
              </button>
            </div>
          )}
        </div>
      </nav>

      <AddFeedDialog open={addFeedOpen} onClose={() => setAddFeedOpen(false)} />

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
