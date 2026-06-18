import { useMutation, useQueryClient } from "@tanstack/react-query";
import { feedLabel, updateFeedMutationOptions } from "../../lib/feeds";
import {
  createFolderMutationOptions,
  deleteFolderMutationOptions,
  renameFolderMutationOptions,
} from "../../lib/folders";
import { AddFeedDialog } from "../AddFeedDialog";
import { NameDialog } from "../NameDialog";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import type { SidebarDialog } from "./sidebar-model";
import type { FeedLifecycle } from "./use-feed-lifecycle";

/**
 * Dialogues de la Sidebar (#48), pilotés par l'union `SidebarDialog` (un seul
 * ouvert à la fois, `null` = aucun). Possède les mutations de cycle de vie des
 * Folders et le renommage de Feed ; reçoit la mutation de désabonnement de Feed
 * déjà câblée à la navigation (`use-feed-lifecycle`). La suppression destructive
 * d'un feed n'a plus de point d'entrée UI (#113) : seul Se désabonner subsiste.
 * Libellé du désabonnement repris mot pour mot (non destructif, cf. ADR 0010).
 */
export function SidebarDialogs({
  dialog,
  onClose,
  unsubscribe,
  online,
}: {
  dialog: SidebarDialog | null;
  onClose: () => void;
  unsubscribe: FeedLifecycle["unsubscribe"];
  /**
   * Connexion réseau. Les déclencheurs de ces dialogues (online-only, ADR 0018)
   * sont déjà désactivés hors-ligne dans la Sidebar ; cette garde couvre le cas
   * d'une connexion **perdue dialogue ouvert** : on désactive alors les
   * confirmations (suppression de Folder, désabonnement de Feed) qui ne
   * passeraient pas par l'optimistic-update et échoueraient au réseau.
   */
  online: boolean;
}) {
  const queryClient = useQueryClient();
  const createFolder = useMutation(createFolderMutationOptions(queryClient));
  const renameFolder = useMutation(renameFolderMutationOptions(queryClient));
  const deleteFolder = useMutation(deleteFolderMutationOptions(queryClient));
  const updateFeed = useMutation(updateFeedMutationOptions(queryClient));

  // Réinitialise les mutations à la fermeture (efface un état d'erreur résiduel).
  function close() {
    createFolder.reset();
    renameFolder.reset();
    deleteFolder.reset();
    updateFeed.reset();
    unsubscribe.reset();
    onClose();
  }

  return (
    <>
      <AddFeedDialog open={dialog?.kind === "addFeed"} onClose={close} />

      {/* Création de Folder. */}
      <NameDialog
        open={dialog?.kind === "createFolder"}
        onClose={close}
        title="Nouveau dossier"
        label="Nom du dossier"
        submitLabel="Créer"
        placeholder="Tech, Perso…"
        pending={createFolder.isPending}
        errorText={
          createFolder.isError ? "Création impossible, réessayez." : undefined
        }
        onSubmit={(name) => createFolder.mutate(name, { onSuccess: close })}
      />

      {/* Renommage de Folder. */}
      <NameDialog
        open={dialog?.kind === "renameFolder"}
        onClose={close}
        title="Renommer le dossier"
        label="Nom du dossier"
        submitLabel="Renommer"
        initialValue={dialog?.kind === "renameFolder" ? dialog.folder.name : ""}
        pending={renameFolder.isPending}
        errorText={
          renameFolder.isError ? "Renommage impossible, réessayez." : undefined
        }
        onSubmit={(name) => {
          if (dialog?.kind !== "renameFolder") return;
          renameFolder.mutate(
            { id: dialog.folder.id, name },
            { onSuccess: close },
          );
        }}
      />

      {/* Renommage de Feed. */}
      <NameDialog
        open={dialog?.kind === "renameFeed"}
        onClose={close}
        title="Renommer le flux"
        label="Nom du flux"
        submitLabel="Renommer"
        initialValue={
          dialog?.kind === "renameFeed" ? feedLabel(dialog.feed) : ""
        }
        pending={updateFeed.isPending}
        errorText={
          updateFeed.isError ? "Renommage impossible, réessayez." : undefined
        }
        onSubmit={(name) => {
          if (dialog?.kind !== "renameFeed") return;
          updateFeed.mutate(
            { id: dialog.feed.id, title: name },
            { onSuccess: close },
          );
        }}
      />

      {/* Confirmation de suppression de Folder. */}
      <Dialog
        open={dialog?.kind === "deleteFolder"}
        onClose={close}
        title="Supprimer le dossier"
      >
        <p className="text-sm text-text">
          Supprimer «&nbsp;
          {dialog?.kind === "deleteFolder" ? dialog.folder.name : ""}&nbsp;» ?
          Ses flux ne seront pas désabonnés : ils repasseront « sans dossier ».
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
          <Button variant="outline" onClick={close}>
            Annuler
          </Button>
          <Button
            variant="danger"
            disabled={deleteFolder.isPending || !online}
            onClick={() => {
              if (dialog?.kind !== "deleteFolder") return;
              deleteFolder.mutate(dialog.folder.id, { onSuccess: close });
            }}
          >
            {deleteFolder.isPending ? "…" : "Supprimer"}
          </Button>
        </div>
      </Dialog>

      {/* Confirmation de désabonnement d'un Feed (#14, non destructif). */}
      <Dialog
        open={dialog?.kind === "unsubscribeFeed"}
        onClose={close}
        title="Se désabonner du flux"
      >
        <p className="text-sm text-text">
          Se désabonner de «&nbsp;
          {dialog?.kind === "unsubscribeFeed" ? feedLabel(dialog.feed) : ""}
          &nbsp;» ? Le polling s'arrête et les articles non sauvegardés sont
          supprimés. Les articles <strong>sauvegardés sont conservés</strong> et
          restent accessibles dans la vue Saved.
        </p>
        {unsubscribe.isError && (
          <p
            className="mt-3 text-red-600 text-sm dark:text-red-400"
            role="alert"
          >
            Désabonnement impossible, réessayez.
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={close}>
            Annuler
          </Button>
          <Button
            variant="primary"
            disabled={unsubscribe.isPending || !online}
            onClick={() => {
              if (dialog?.kind !== "unsubscribeFeed") return;
              unsubscribe.mutate(dialog.feed, { onSuccess: close });
            }}
          >
            {unsubscribe.isPending ? "…" : "Se désabonner"}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
