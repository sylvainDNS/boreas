import { queryOptions, useQuery } from "@tanstack/react-query";
import { countOutbox } from "./outbox-store";
import { getReplica } from "./replica";

/**
 * Badge « actions en attente » (#81, ADR 0018 « Affordances UI ») : expose le
 * nombre d'entrées de l'outbox (mutations de lecture pas encore poussées). La
 * source est le réplica IndexedDB (`countOutbox`) ; on l'enveloppe dans une query
 * react-query pour que les composants la réactualisent par invalidation.
 *
 * **Rafraîchissement** : la clé `OUTBOX_COUNT_KEY` est invalidée (1) après chaque
 * mutation de lecture (Read/Saved/mark-all-read, qui empile une entrée) et (2)
 * après chaque passe de sync (`useReplicaSync`, qui flushe l'outbox). Le badge
 * monte donc quand on agit hors-ligne et redescend à 0 à la reconnexion.
 */
export const OUTBOX_COUNT_KEY = ["outbox", "count"] as const;

export function outboxCountQueryOptions() {
  return queryOptions({
    queryKey: OUTBOX_COUNT_KEY,
    queryFn: async () => countOutbox(await getReplica()),
  });
}

/** Nombre d'actions en attente (outbox) ; `0` tant que la query n'a pas chargé. */
export function useOutboxCount(): number {
  const { data } = useQuery(outboxCountQueryOptions());
  return data ?? 0;
}
