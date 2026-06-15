import { useOutboxCount } from "../lib/sync/use-outbox";
import { useOnlineStatus } from "../lib/use-online-status";

/**
 * Affordances hors-ligne de la Sidebar (#81, ADR 0018) : un **indicateur de
 * connexion** discret (affiché seulement hors-ligne) et un **badge « actions en
 * attente »** (entrées de l'outbox pas encore poussées). Les deux sont des
 * lectures réactives : `useOnlineStatus` (events online/offline) et
 * `useOutboxCount` (query invalidée par les mutations + la sync).
 *
 * Rien à afficher en ligne sans action en attente → composant **inerte** (rien
 * rendu), pour ne pas alourdir la navigation au cas nominal.
 */
export function OfflineStatus() {
  const online = useOnlineStatus();
  const pending = useOutboxCount();

  if (online && pending === 0) return null;

  return (
    <div className="space-y-1 px-3 py-2 text-xs" aria-live="polite">
      {!online && (
        <div className="flex items-center gap-2 text-muted" role="status">
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-full bg-muted/60"
          />
          <span>Hors-ligne — lecture depuis la copie locale.</span>
        </div>
      )}
      {pending > 0 && (
        <div className="flex items-center gap-2 text-muted">
          <span
            aria-hidden
            className="size-2 shrink-0 animate-pulse rounded-full bg-accent"
          />
          <span>
            {pending} action{pending > 1 ? "s" : ""} en attente
          </span>
        </div>
      )}
    </div>
  );
}
