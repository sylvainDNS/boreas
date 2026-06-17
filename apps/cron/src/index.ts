/**
 * Worker Cron — ingestion automatique (ADR 0002).
 *
 * `scheduled` (~5 min) sélectionne les Feeds dus et enqueue un message par Feed ;
 * `queue` consomme ces messages et ingère chaque Feed via le module partagé.
 *
 * Tester le scheduled localement : wrangler dev --config wrangler.jsonc --test-scheduled
 */
import {
  backfillFeed,
  getDb,
  type IngestionMessage,
  ingestFeed,
} from "@boreas/shared";
import { vapidKeysFromEnv } from "@boreas/shared/crypto";
import { processIngestionBatch, runScheduledTick } from "./consumer";
import { notifyNewArticles } from "./push-notify";

interface Env {
  DB: D1Database;
  /** Bucket R2 : HTML plein extrait à l'ingestion (`articles/{id}.html`). */
  BUCKET: R2Bucket;
  /** Clé HMAC partagée (api + cron) pour signer les URLs d'images. Secret Worker. */
  HMAC_SECRET: string;
  /** Queue d'ingestion — producteur (scheduled → enqueue) et consommateur (queue → ingest). */
  INGESTION_QUEUE: Queue<IngestionMessage>;
  /** Clé publique VAPID (point P-256 brut, base64url) — `k=` du header push (#80). */
  VAPID_PUBLIC_KEY: string;
  /** Clé privée VAPID (PKCS#8 base64url) — secret Worker, signe le JWT push (#80). */
  VAPID_PRIVATE_KEY: string;
  /** Sujet VAPID (`mailto:` ou URL de contact) (#80). */
  VAPID_SUBJECT: string;
}

export default {
  /**
   * Cron Trigger (~5 min) : adapter trivial — logue l'entrée puis délègue le tick
   * (sélection des Feeds dus, enqueue, rétention) à `runScheduledTick` (ADR 0002).
   * Le compte de Feeds dus est logué à partir des ids renvoyés, sans re-SELECT.
   */
  async scheduled(
    event: ScheduledEvent,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const db = getDb(env.DB);
    const ids = await runScheduledTick(db, env.INGESTION_QUEUE, env.BUCKET);
    console.log("[cron:scheduled] triggered", {
      cron: event.cron,
      scheduledTime: new Date(event.scheduledTime).toISOString(),
      dueFeeds: ids.length,
    });
  },

  /**
   * Consommateur de Queue : adapter trivial — logue l'entrée puis délègue à
   * `processIngestionBatch`, en injectant `ingestFeed` lié au contexte du Worker
   * (D1 + R2 + HMAC) et `notifyNewArticles` (push « article prêt à lire », #80,
   * best-effort). La politique ack-toujours vit dans le module (ADR 0002, #11).
   */
  async queue(
    batch: MessageBatch<IngestionMessage>,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const db = getDb(env.DB);
    const vapid = vapidKeysFromEnv(env);
    console.log("[cron:queue] batch received", {
      queue: batch.queue,
      count: batch.messages.length,
    });

    await processIngestionBatch(batch.messages, {
      ingest: (feedId) => ingestFeed(feedId, db, env.BUCKET, env.HMAC_SECRET),
      backfill: (feedId) =>
        backfillFeed(feedId, db, env.BUCKET, env.HMAC_SECRET),
      notify: (result) => notifyNewArticles(result, db, vapid),
    });
  },
};
