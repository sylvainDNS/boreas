import {
  type ArticleContentResponse,
  type ArticlePatchResponse,
  articleContentResponseSchema,
  type MarkReadResponse,
  type SyncResponse,
  syncResponseSchema,
} from "@boreas/api-contracts";
import { apiFetch } from "../api";
import type { OutboxEntry } from "./replica-store";

/**
 * Transport du moteur de sync (#72/#74, ADR 0018) : **les seuls** appels réseau
 * du chemin réplica. Pull descendant (`GET /api/sync`) et push montant des
 * mutations de l'outbox (`PATCH /api/articles/:id`, `POST /api/articles/mark-read`).
 * Validation zod côté pull (le wire est la frontière de confiance).
 *
 * `since=0` (réplica vierge) déclenche la sync initiale complète paginée côté
 * serveur ; on omet alors le paramètre pour rester lisible.
 */
export async function pullSyncDelta(since: number): Promise<SyncResponse> {
  const query = since > 0 ? `?since=${since}` : "";
  const body = await apiFetch<unknown>(`/sync${query}`);
  return syncResponseSchema.parse(body);
}

/**
 * Pull le HTML d'un lot d'articles (#75, ADR 0018) : `POST /api/articles/content
 * {ids[]}` → `[{id, html}]`, **sans effet Read**. Appelé par le moteur de sync
 * pour pré-télécharger le corpus offline (non-lus ∪ Saved). Validation zod (le
 * wire est la frontière de confiance, comme pour le pull du delta).
 */
export async function pullArticleContent(
  ids: string[],
): Promise<ArticleContentResponse> {
  const body = await apiFetch<unknown>("/articles/content", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
  return articleContentResponseSchema.parse(body);
}

/**
 * Pousse une entrée d'outbox vers l'API (sync montante, #74). Mappe l'entrée
 * discriminée vers sa requête : `patch` → `PATCH /api/articles/:id {field}` ;
 * `markRead` → `POST /api/articles/mark-read {scope}` (une seule requête de
 * portée, jamais N patchs). Toute non-2xx lève `ApiError` (via `apiFetch`) :
 * `flushOutbox` l'interprète (401 → ré-auth, réseau → re-flush ultérieur).
 */
export async function pushOutboxEntry(entry: OutboxEntry): Promise<void> {
  if (entry.kind === "patch") {
    await apiFetch<ArticlePatchResponse>(`/articles/${entry.articleId}`, {
      method: "PATCH",
      body: JSON.stringify({ [entry.field]: entry.value }),
    });
    return;
  }
  await apiFetch<MarkReadResponse>("/articles/mark-read", {
    method: "POST",
    body: JSON.stringify(entry.scope),
  });
}
