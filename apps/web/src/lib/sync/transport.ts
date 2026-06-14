import { type SyncResponse, syncResponseSchema } from "@boreas/api-contracts";
import { apiFetch } from "../api";

/**
 * Transport du moteur de sync (#72, ADR 0018) : **le seul** appel réseau du
 * chemin réplica. Pull une page de delta depuis `GET /api/sync?since=<curseur>`
 * et valide la réponse au contrat zod (le wire est la frontière de confiance).
 *
 * `since=0` (réplica vierge) déclenche la sync initiale complète paginée côté
 * serveur ; on omet alors le paramètre pour rester lisible.
 */
export async function pullSyncDelta(since: number): Promise<SyncResponse> {
  const query = since > 0 ? `?since=${since}` : "";
  const body = await apiFetch<unknown>(`/sync${query}`);
  return syncResponseSchema.parse(body);
}
