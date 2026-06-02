/**
 * Worker Cron — stubs démarrables.
 *
 * Implémentation complète : issue #10 (Ingestion auto Cron + Queues).
 * Tester le scheduled localement : wrangler dev --config wrangler.jsonc --test-scheduled
 */

interface Env {
  DB: D1Database;
  /** Queue d'ingestion — producteur (scheduled → enqueue) et consommateur (queue → ingest). */
  INGESTION_QUEUE: Queue;
}

export default {
  /**
   * Cron Trigger (~5 min) : sélectionne les feeds dus et les enqueue. (ADR 0002)
   * TODO #10 : SELECT feeds WHERE next_check_at <= now → INGESTION_QUEUE.send()
   *            puis lancer la purge de rétention.
   */
  async scheduled(
    event: ScheduledEvent,
    _env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    console.log("[cron:scheduled] triggered", {
      cron: event.cron,
      scheduledTime: new Date(event.scheduledTime).toISOString(),
    });
  },

  /**
   * Consommateur de Queue : ingère chaque feed. (ADR 0002)
   * TODO #10 : pour chaque message → ingestFeed() du module partagé.
   */
  async queue(
    batch: MessageBatch<unknown>,
    _env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    console.log("[cron:queue] batch received", {
      queue: batch.queue,
      count: batch.messages.length,
    });
    batch.ackAll();
  },
};
