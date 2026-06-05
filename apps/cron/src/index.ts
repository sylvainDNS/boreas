/**
 * Worker Cron — ingestion automatique (ADR 0002).
 *
 * `scheduled` (~5 min) sélectionne les Feeds dus et enqueue un message par Feed ;
 * `queue` consomme ces messages et ingère chaque Feed via le module partagé.
 *
 * Tester le scheduled localement : wrangler dev --config wrangler.jsonc --test-scheduled
 */
import {
  enqueueFeedIds,
  getDb,
  getDueFeedIds,
  type IngestionMessage,
  ingestFeed,
} from "@boreas/shared";

interface Env {
  DB: D1Database;
  /** Bucket R2 : HTML plein extrait à l'ingestion (`articles/{id}.html`). */
  BUCKET: R2Bucket;
  /** Clé HMAC partagée (api + cron) pour signer les URLs d'images. Secret Worker. */
  HMAC_SECRET: string;
  /** Queue d'ingestion — producteur (scheduled → enqueue) et consommateur (queue → ingest). */
  INGESTION_QUEUE: Queue<IngestionMessage>;
}

export default {
  /**
   * Cron Trigger (~5 min) : sélectionne les Feeds dus (`next_check_at` échu ou
   * null) et enqueue un message par Feed. (ADR 0002)
   * TODO #15 : déclencher ici la purge de rétention.
   */
  async scheduled(
    event: ScheduledEvent,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const db = getDb(env.DB);
    const ids = await getDueFeedIds(db);
    console.log("[cron:scheduled] triggered", {
      cron: event.cron,
      scheduledTime: new Date(event.scheduledTime).toISOString(),
      dueFeeds: ids.length,
    });

    await enqueueFeedIds(env.INGESTION_QUEUE, ids);
  },

  /**
   * Consommateur de Queue : ingère chaque Feed via le module partagé. (ADR 0002)
   *
   * `ingestFeed` avance toujours `next_check_at` (même 304/erreur), donc on `ack`
   * chaque message : un échec sera retenté au prochain tick plutôt que via les
   * retries de Queue (backoff fin = #11).
   */
  async queue(
    batch: MessageBatch<IngestionMessage>,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const db = getDb(env.DB);
    console.log("[cron:queue] batch received", {
      queue: batch.queue,
      count: batch.messages.length,
    });

    for (const message of batch.messages) {
      try {
        const result = await ingestFeed(
          message.body.feedId,
          db,
          env.BUCKET,
          env.HMAC_SECRET,
        );
        if (result.status === "error") {
          console.error("[cron:queue] ingestion en erreur", {
            feedId: result.feedId,
            error: result.error,
          });
        }
      } catch (err) {
        console.error(
          "[cron:queue] ingestion a levé",
          message.body.feedId,
          err,
        );
      }
      message.ack();
    }
  },
};
