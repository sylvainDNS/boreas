/**
 * Consommateur de Queue d'ingestion et orchestration du tick `scheduled` du
 * Worker Cron (ADR 0002), extraits d'`index.ts` en seams testables. La politique
 * d'ack reste inchangée : chaque message est acké **inconditionnellement** après
 * son traitement, succès comme échec — un Feed qui échoue est retenté au prochain
 * tick via `next_check_at` + backoff exponentiel (#11), pas via les retries Queue.
 */

import type { Db } from "@boreas/shared";
import {
  enqueueFeedIds,
  getDueFeedIds,
  type IngestionMessage,
  type IngestResult,
  runRetention,
} from "@boreas/shared";

/**
 * Sous-type structurel de `Message<T>` Cloudflare réduit aux deux membres dont
 * le consommateur a besoin : `batch.messages` y est assignable en prod, et un
 * test fabrique `{ body, ack: vi.fn() }` sans avoir à mocker tout `MessageBatch`.
 */
export interface AckableMessage<T> {
  readonly body: T;
  ack(): void;
}

/** Dépendances injectables du traitement d'un batch (ingestion d'un Feed). */
export interface IngestionDeps {
  ingest(feedId: string): Promise<IngestResult>;
}

/**
 * Traite un batch de messages d'ingestion : pour chaque message, ingère le Feed
 * puis l'**ack inconditionnellement**, dans un try/catch qui isole l'échec d'un
 * message des suivants. La politique ack-toujours est figée ici (ADR 0002, #11) :
 * un `status:"error"` comme un rejet de `ingest` est logué mais n'empêche jamais
 * l'ack, car `ingestFeed` a déjà avancé `next_check_at` (retry au prochain tick).
 */
export async function processIngestionBatch<T extends IngestionMessage>(
  messages: readonly AckableMessage<T>[],
  deps: IngestionDeps,
): Promise<void> {
  for (const message of messages) {
    try {
      const result = await deps.ingest(message.body.feedId);
      if (result.status === "error") {
        console.error("[cron:queue] ingestion en erreur", {
          feedId: result.feedId,
          error: result.error,
        });
      }
    } catch (err) {
      console.error("[cron:queue] ingestion a levé", message.body.feedId, err);
    }
    message.ack();
  }
}

/**
 * Orchestre un tick `scheduled` (ADR 0002) : sélectionne les Feeds dus, enqueue
 * un message par Feed, puis lance la rétention (#15) **isolée dans son propre
 * try/catch** pour qu'un échec n'affecte pas l'enqueue déjà émis. Logique reprise
 * telle quelle d'`index.ts` ; renvoie les ids dus pour que l'adapter logue le
 * compte sans re-SELECT.
 */
export async function runScheduledTick(
  db: Db,
  queue: Pick<Queue<IngestionMessage>, "sendBatch">,
  bucket: R2Bucket,
): Promise<string[]> {
  const ids = await getDueFeedIds(db);
  await enqueueFeedIds(queue, ids);

  try {
    await runRetention(db, bucket);
  } catch (err) {
    console.error("[cron:scheduled] rétention a levé", err);
  }

  return ids;
}
