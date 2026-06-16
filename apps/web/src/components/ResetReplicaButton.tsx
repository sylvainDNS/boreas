import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { syncReplica, wipeReplica } from "../lib/sync/replica";
import { invalidateOfflineViews } from "../lib/sync/use-replica-sync";
import { useOnlineStatus } from "../lib/use-online-status";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";

/**
 * Trappe de secours « Forcer une resynchronisation » (Réglages) : supprime le
 * réplica local puis relance un resync complet depuis le serveur. Sœur **manuelle**
 * de la récup auto sur curseur périmé (ADR 0018), déclenchée quand la sync se
 * coince. Elle **jette l'outbox** (mutations Read/Saved non poussées), d'où la
 * confirmation explicite.
 *
 * Désactivée hors-ligne (comme les suppressions Feed/Folder) : vider sans réseau
 * laisserait l'app vide jusqu'à reconnexion. Pattern async local (`pending`/`error`)
 * calqué sur `PushToggle` — action impérative one-shot, pas un fetch React Query.
 */
export function ResetReplicaButton() {
  const online = useOnlineStatus();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    if (pending) return; // ne ferme pas en plein vidage
    setOpen(false);
    setError(null);
  }

  async function onConfirm() {
    setPending(true);
    setError(null);
    try {
      await wipeReplica();
      await syncReplica();
      setOpen(false);
    } catch {
      setError("Réinitialisation impossible, réessayez.");
    } finally {
      // Quoi qu'il arrive après le wipe, les vues doivent relire le réplica : sur
      // échec de resync (réseau coupé en cours) le réplica est vide, et un cache
      // React Query encore peuplé afficherait des articles fantômes. La sync de
      // fond (useReplicaSync) le re-remplira ensuite.
      void invalidateOfflineViews(queryClient);
      setPending(false);
    }
  }

  return (
    <>
      <div className="flex flex-col items-end gap-1">
        <Button
          variant="danger"
          disabled={!online}
          onClick={() => setOpen(true)}
        >
          Forcer une resynchronisation
        </Button>
        {!online && (
          <p className="text-muted text-sm">
            Reconnectez-vous pour réinitialiser.
          </p>
        )}
      </div>
      <Dialog
        open={open}
        onClose={close}
        title="Forcer une resynchronisation ?"
      >
        <p className="text-sm text-text">
          Les données locales (articles, contenus hors-ligne, et les changements
          de lecture pas encore synchronisés) seront supprimées puis
          retéléchargées depuis le serveur. Vos articles sauvegardés et
          l'historique côté serveur ne sont pas affectés.
        </p>
        {error && (
          <p
            className="mt-3 text-red-600 text-sm dark:text-red-400"
            role="alert"
          >
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" disabled={pending} onClick={close}>
            Annuler
          </Button>
          <Button
            variant="danger"
            disabled={pending || !online}
            onClick={onConfirm}
          >
            {pending ? "Réinitialisation…" : "Confirmer"}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
