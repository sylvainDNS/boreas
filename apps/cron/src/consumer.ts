/**
 * Consommateur de Queue d'ingestion et orchestration du tick `scheduled` du
 * Worker Cron (ADR 0002), extraits d'`index.ts` en seams testables. La politique
 * d'ack reste inchangée : chaque message est acké **inconditionnellement** après
 * son traitement, succès comme échec — un Feed qui échoue est retenté au prochain
 * tick via `next_check_at` + backoff exponentiel (#11), pas via les retries Queue.
 */

import type { BackfillResult, Db } from "@boreas/shared";
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

/** Dépendances injectables du traitement d'un batch (ingestion ou backfill d'un Feed). */
export interface IngestionDeps {
  ingest(feedId: string): Promise<IngestResult>;
  /**
   * Ré-sanitize en place le contenu R2 des articles déjà stockés d'un Feed
   * (#97), appelé pour les messages `mode:"backfill"`. Aucun net-new, donc pas
   * de notification. Optionnelle : absente, un message backfill est acké sans
   * traitement (env/tests qui n'exercent que l'ingestion).
   */
  backfill?(feedId: string): Promise<BackfillResult>;
  /**
   * Émet la notification push « article prêt à lire » d'un Feed (#80), appelée
   * **après** une ingestion ayant inséré des net-new. Optionnelle : absente, le
   * batch s'ingère sans notifier (env sans VAPID, tests). Best-effort — son
   * échec est isolé par `processIngestionBatch` et ne bloque jamais l'ack.
   */
  notify?(result: IngestResult): Promise<void>;
}

/**
 * Traite un batch de messages : pour chaque message, l'ingère ou le backfille
 * selon son `mode` (#97), puis l'**ack inconditionnellement**, dans un try/catch
 * qui isole l'échec d'un message des suivants. La politique ack-toujours est
 * figée ici (ADR 0002, #11) : un `status:"error"` comme un rejet du traitement
 * est logué mais n'empêche jamais l'ack — l'ingestion a déjà avancé
 * `next_check_at` (retry au prochain tick), et un backfill est relançable.
 */
export async function processIngestionBatch<T extends IngestionMessage>(
  messages: readonly AckableMessage<T>[],
  deps: IngestionDeps,
): Promise<void> {
  for (const message of messages) {
    try {
      if (message.body.mode === "backfill") {
        await processBackfillMessage(message.body.feedId, deps);
      } else {
        await processIngestMessage(message.body.feedId, deps);
      }
    } catch (err) {
      console.error("[cron:queue] traitement a levé", message.body, err);
    }
    message.ack();
  }
}

/** Ingestion normale d'un Feed (poll) + notification push best-effort (#80). */
async function processIngestMessage(
  feedId: string,
  deps: IngestionDeps,
): Promise<void> {
  const result = await deps.ingest(feedId);
  // Notification push (#80), best-effort : uniquement quand l'ingestion a
  // inséré des net-new. Son échec (réseau, VAPID, idb) est isolé ici pour ne
  // jamais empêcher l'ack ni le traitement des messages suivants.
  if (result.status === "updated" && result.inserted > 0) {
    try {
      await deps.notify?.(result);
    } catch (err) {
      console.error(
        "[cron:queue] notification push a levé",
        result.feedId,
        err,
      );
    }
  }
  if (result.status === "error") {
    console.error("[cron:queue] ingestion en erreur", {
      feedId: result.feedId,
      error: result.error,
    });
  }
}

/**
 * Backfill d'un Feed (#97) : ré-sanitization en place du contenu existant.
 * Aucun net-new → jamais de notification. Si `deps.backfill` est absent, le
 * message est acké sans traitement mais **logué** : en prod l'adapter câble
 * toujours `backfill`, donc une absence signale un mauvais wiring qu'on ne veut
 * pas avaler en silence (le message serait perdu, l'API ayant répondu OK).
 */
async function processBackfillMessage(
  feedId: string,
  deps: IngestionDeps,
): Promise<void> {
  if (!deps.backfill) {
    console.error(
      "[cron:queue] message backfill reçu sans handler backfill, ignoré",
      feedId,
    );
    return;
  }
  const result = await deps.backfill(feedId);
  if (result.status === "error") {
    console.error("[cron:queue] backfill en erreur", {
      feedId: result.feedId,
      error: result.error,
    });
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
