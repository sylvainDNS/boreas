import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useMatchRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { articleCountsQueryOptions } from "../lib/articles";
import { AUTH_QUERY_KEY, logout } from "../lib/auth";
import {
  type Feed,
  feedLabel,
  feedsQueryOptions,
  updateFeedMutationOptions,
} from "../lib/feeds";
import {
  createFolderMutationOptions,
  deleteFolderMutationOptions,
  type Folder,
  foldersQueryOptions,
  renameFolderMutationOptions,
} from "../lib/folders";
import { AddFeedDialog } from "./AddFeedDialog";
import { NameDialog } from "./NameDialog";
import { MenuLabel, menuItemClass, RowMenu } from "./RowMenu";
import { ThemeToggle } from "./ThemeToggle";
import { CountBadge, ErrorBadge } from "./ui/Badge";
import { BrandLogo } from "./ui/BrandLogo";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";

const itemBase =
  "flex min-h-11 w-full items-center gap-2 rounded-card px-3 text-left text-sm transition-colors hover:bg-surface-2";
const itemActive = "bg-surface-2 font-medium text-accent";

/** Cible de renommage en cours (Folder ou Feed), pour le `NameDialog` partagé. */
type RenameTarget =
  | { kind: "folder"; id: string; name: string }
  | { kind: "feed"; id: string; name: string };

/** Colonne de navigation : marque, vues globales, Folders/Feeds, thème, réglages. */
export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const navigate = useNavigate();
  const matchRoute = useMatchRoute();
  const queryClient = useQueryClient();

  const [addFeedOpen, setAddFeedOpen] = useState(false);
  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [folderToDelete, setFolderToDelete] = useState<Folder | null>(null);
  // Folders repliés (par défaut tous dépliés : un id présent = replié).
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  // Compteur global de non-lus exact (#8) + agrégats par feed et par folder (#13).
  const counts = useQuery(articleCountsQueryOptions());
  const feeds = useQuery(feedsQueryOptions());
  const folders = useQuery(foldersQueryOptions());

  const unreadByFeed = useMemo(
    () => new Map(counts.data?.byFeed.map((f) => [f.feedId, f.count])),
    [counts.data],
  );
  const unreadByFolder = useMemo(
    () => new Map(counts.data?.byFolder.map((f) => [f.folderId, f.count])),
    [counts.data],
  );

  const createFolder = useMutation(createFolderMutationOptions(queryClient));
  const renameFolder = useMutation(renameFolderMutationOptions(queryClient));
  const deleteFolder = useMutation(deleteFolderMutationOptions(queryClient));
  const updateFeed = useMutation(updateFeedMutationOptions(queryClient));

  const foldersData = folders.data ?? [];
  const feedsData = feeds.data ?? [];

  // Groupe les feeds par folder en un seul passage (évite un filter O(feeds) par
  // folder rendu). Un feed dont le `folderId` ne correspond à aucun Folder connu
  // (folder supprimé/non encore chargé) est traité comme « sans dossier » : il
  // reste ainsi visible plutôt que de disparaître de la sidebar.
  const { feedsByFolder, unfiledFeeds } = useMemo(() => {
    const known = new Set(foldersData.map((f) => f.id));
    const byFolder = new Map<string, Feed[]>();
    const unfiled: Feed[] = [];
    for (const feed of feedsData) {
      if (feed.folderId != null && known.has(feed.folderId)) {
        const list = byFolder.get(feed.folderId);
        if (list) list.push(feed);
        else byFolder.set(feed.folderId, [feed]);
      } else {
        unfiled.push(feed);
      }
    }
    return { feedsByFolder: byFolder, unfiledFeeds: unfiled };
  }, [foldersData, feedsData]);

  function toggleCollapse(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function moveFeed(id: string, folderId: string | null) {
    updateFeed.mutate({ id, folderId });
  }

  async function handleLogout() {
    await logout();
    queryClient.setQueryData(AUTH_QUERY_KEY, false);
    onNavigate?.();
    await navigate({ to: "/login" });
  }

  /** Rend une ligne Feed (utilisée dans un Folder et dans la liste « sans dossier »). */
  function renderFeed(feed: Feed) {
    const isActive = Boolean(
      matchRoute({ to: "/feeds/$feedId", params: { feedId: feed.id } }),
    );
    const unread = unreadByFeed.get(feed.id) ?? 0;
    return (
      <div
        key={feed.id}
        className={`group ${itemBase} ${isActive ? itemActive : ""}`}
      >
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
                  setRenameTarget({
                    kind: "feed",
                    id: feed.id,
                    name: feedLabel(feed),
                  });
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
                  moveFeed(feed.id, null);
                }}
              >
                Aucun dossier {feed.folderId == null ? "✓" : ""}
              </button>
              {foldersData.map((folder) => (
                <button
                  key={folder.id}
                  type="button"
                  role="menuitem"
                  className={menuItemClass}
                  disabled={feed.folderId === folder.id}
                  onClick={() => {
                    close();
                    moveFeed(feed.id, folder.id);
                  }}
                >
                  <span className="truncate">{folder.name}</span>
                  {feed.folderId === folder.id ? " ✓" : ""}
                </button>
              ))}
            </>
          )}
        </RowMenu>
      </div>
    );
  }

  /** Rend un groupe Folder dépliable + ses Feeds. */
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
                    setRenameTarget({
                      kind: "folder",
                      id: folder.id,
                      name: folder.name,
                    });
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
                    setFolderToDelete(folder);
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

        {/* Section Dossiers (#13) : groupes dépliables. */}
        <div className="pt-3">
          <div className="flex items-center justify-between px-3 pb-1">
            <p className="font-semibold text-[0.7rem] text-muted uppercase tracking-wide">
              Dossiers
            </p>
            <button
              type="button"
              onClick={() => setCreateFolderOpen(true)}
              aria-label="Nouveau dossier"
              title="Nouveau dossier"
              className="rounded-card px-1.5 text-base text-muted leading-none transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
            >
              +
            </button>
          </div>
          {foldersData.map(renderFolder)}
          {foldersData.length === 0 && (
            <p className="px-3 py-1 text-muted text-sm">Aucun dossier.</p>
          )}
        </div>

        {/* Section Flux : uniquement les feeds sans dossier. */}
        <div className="pt-3">
          <div className="flex items-center justify-between px-3 pb-1">
            <p className="font-semibold text-[0.7rem] text-muted uppercase tracking-wide">
              {foldersData.length > 0 ? "Flux (sans dossier)" : "Flux"}
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
          {unfiledFeeds.map(renderFeed)}
          {feedsData.length === 0 && (
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

      {/* Création de Folder. */}
      <NameDialog
        open={createFolderOpen}
        onClose={() => {
          setCreateFolderOpen(false);
          createFolder.reset();
        }}
        title="Nouveau dossier"
        label="Nom du dossier"
        submitLabel="Créer"
        placeholder="Tech, Perso…"
        pending={createFolder.isPending}
        errorText={
          createFolder.isError ? "Création impossible, réessayez." : undefined
        }
        onSubmit={(name) =>
          createFolder.mutate(name, {
            onSuccess: () => setCreateFolderOpen(false),
          })
        }
      />

      {/* Renommage de Folder ou de Feed (dialog partagé). */}
      <NameDialog
        open={renameTarget !== null}
        onClose={() => {
          setRenameTarget(null);
          renameFolder.reset();
          updateFeed.reset();
        }}
        title={
          renameTarget?.kind === "folder"
            ? "Renommer le dossier"
            : "Renommer le flux"
        }
        label={
          renameTarget?.kind === "folder" ? "Nom du dossier" : "Nom du flux"
        }
        submitLabel="Renommer"
        initialValue={renameTarget?.name ?? ""}
        pending={renameFolder.isPending || updateFeed.isPending}
        errorText={
          renameFolder.isError || updateFeed.isError
            ? "Renommage impossible, réessayez."
            : undefined
        }
        onSubmit={(name) => {
          if (!renameTarget) return;
          if (renameTarget.kind === "folder") {
            renameFolder.mutate(
              { id: renameTarget.id, name },
              { onSuccess: () => setRenameTarget(null) },
            );
          } else {
            updateFeed.mutate(
              { id: renameTarget.id, title: name },
              { onSuccess: () => setRenameTarget(null) },
            );
          }
        }}
      />

      {/* Confirmation de suppression de Folder. */}
      <Dialog
        open={folderToDelete !== null}
        onClose={() => {
          setFolderToDelete(null);
          deleteFolder.reset();
        }}
        title="Supprimer le dossier"
      >
        <p className="text-sm text-text">
          Supprimer «&nbsp;{folderToDelete?.name}&nbsp;» ? Ses flux ne seront
          pas désabonnés : ils repasseront « sans dossier ».
        </p>
        {deleteFolder.isError && (
          <p
            className="mt-3 text-red-600 text-sm dark:text-red-400"
            role="alert"
          >
            Suppression impossible, réessayez.
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setFolderToDelete(null)}>
            Annuler
          </Button>
          <Button
            variant="danger"
            disabled={deleteFolder.isPending}
            onClick={() => {
              if (!folderToDelete) return;
              deleteFolder.mutate(folderToDelete.id, {
                onSuccess: () => setFolderToDelete(null),
              });
            }}
          >
            {deleteFolder.isPending ? "…" : "Supprimer"}
          </Button>
        </div>
      </Dialog>

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
