import { env } from "cloudflare:test";
import type { BackfillResult, IngestResult } from "@boreas/shared";
import { getDb } from "@boreas/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AckableMessage,
  processIngestionBatch,
  runScheduledTick,
} from "../src/consumer";

/** Fabrique un message ackable minimal (sous-type structurel de `Message<T>`). */
function makeMessage<T>(body: T): AckableMessage<T> {
  return { body, ack: vi.fn() };
}

/** Résultat d'ingestion réussi par défaut, surchargé au cas par cas. */
function ingestResult(overrides: Partial<IngestResult> = {}): IngestResult {
  return {
    feedId: "feed-1",
    status: "updated",
    inserted: 0,
    newArticleTitles: [],
    itemCount: 0,
    title: null,
    consecutiveFailures: 0,
    ...overrides,
  };
}

/** Résultat de backfill réussi par défaut, surchargé au cas par cas. */
function backfillResult(
  overrides: Partial<BackfillResult> = {},
): BackfillResult {
  return {
    feedId: "feed-1",
    status: "updated",
    rewritten: 0,
    itemCount: 0,
    ...overrides,
  };
}

describe("processIngestionBatch", () => {
  it("ingère chaque message du batch et ack chacun une fois", async () => {
    const messages = [
      makeMessage({ feedId: "feed-1" }),
      makeMessage({ feedId: "feed-2" }),
      makeMessage({ feedId: "feed-3" }),
    ];
    const ingest = vi.fn(async (feedId: string) => ingestResult({ feedId }));

    await processIngestionBatch(messages, { ingest });

    expect(ingest).toHaveBeenCalledTimes(3);
    expect(ingest.mock.calls.map(([id]) => id)).toEqual([
      "feed-1",
      "feed-2",
      "feed-3",
    ]);
    for (const message of messages) {
      expect(message.ack).toHaveBeenCalledTimes(1);
    }
  });

  it("ack tout de même un message dont l'ingestion renvoie status:error, et traite les suivants", async () => {
    // Chemin d'erreur attendu : le consumer logue l'échec isolé. On capture le
    // `console.error` pour garder la sortie de test propre **et** asserter qu'il
    // a bien tracé l'incident (le log fait partie du comportement, ADR 0002).
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const messages = [
      makeMessage({ feedId: "feed-1" }),
      makeMessage({ feedId: "feed-2" }),
    ];
    const ingest = vi.fn(async (feedId: string) =>
      feedId === "feed-1"
        ? ingestResult({ feedId, status: "error", error: "http_500" })
        : ingestResult({ feedId }),
    );

    await processIngestionBatch(messages, { ingest });

    expect(ingest).toHaveBeenCalledTimes(2);
    expect(messages[0]?.ack).toHaveBeenCalledTimes(1);
    expect(messages[1]?.ack).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[cron:queue] ingestion en erreur"),
      expect.objectContaining({ feedId: "feed-1", error: "http_500" }),
    );
    errorSpy.mockRestore();
  });

  it("ack tout de même un message dont l'ingestion rejette, sans bloquer les suivants", async () => {
    // Idem : `ingest` qui lève est isolé et logué ; on capture le log.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const messages = [
      makeMessage({ feedId: "feed-1" }),
      makeMessage({ feedId: "feed-2" }),
    ];
    const ingest = vi.fn(async (feedId: string) => {
      if (feedId === "feed-1") throw new Error("boom");
      return ingestResult({ feedId });
    });

    await processIngestionBatch(messages, { ingest });

    expect(ingest).toHaveBeenCalledTimes(2);
    expect(messages[0]?.ack).toHaveBeenCalledTimes(1);
    expect(messages[1]?.ack).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[cron:queue] traitement a levé"),
      expect.objectContaining({ feedId: "feed-1" }),
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it("ne fait rien sur un batch vide", async () => {
    const ingest = vi.fn(async (feedId: string) => ingestResult({ feedId }));

    await processIngestionBatch([], { ingest });

    expect(ingest).not.toHaveBeenCalled();
  });

  it("notifie (#80) un Feed dont l'ingestion a inséré des net-new", async () => {
    const ingest = vi.fn(async (feedId: string) =>
      ingestResult({ feedId, inserted: 2, newArticleTitles: ["A", "B"] }),
    );
    const notify = vi.fn(async () => {});

    await processIngestionBatch([makeMessage({ feedId: "feed-1" })], {
      ingest,
      notify,
    });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toMatchObject({
      feedId: "feed-1",
      inserted: 2,
    });
  });

  it("ne notifie pas quand aucun article net-new n'est inséré (inserted=0)", async () => {
    const ingest = vi.fn(async (feedId: string) =>
      ingestResult({ feedId, status: "not_modified", inserted: 0 }),
    );
    const notify = vi.fn(async () => {});

    await processIngestionBatch([makeMessage({ feedId: "feed-1" })], {
      ingest,
      notify,
    });

    expect(notify).not.toHaveBeenCalled();
  });

  it("ne notifie pas un Feed en erreur, même avec un inserted résiduel improbable", async () => {
    const ingest = vi.fn(async (feedId: string) =>
      ingestResult({ feedId, status: "error", error: "http_500", inserted: 0 }),
    );
    const notify = vi.fn(async () => {});

    await processIngestionBatch([makeMessage({ feedId: "feed-1" })], {
      ingest,
      notify,
    });

    expect(notify).not.toHaveBeenCalled();
  });

  it("ack tout de même et poursuit si la notification (#80) lève", async () => {
    // `notify` best-effort qui lève est isolé et logué ; on capture le log.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const messages = [
      makeMessage({ feedId: "feed-1" }),
      makeMessage({ feedId: "feed-2" }),
    ];
    const ingest = vi.fn(async (feedId: string) =>
      ingestResult({ feedId, inserted: 1, newArticleTitles: ["A"] }),
    );
    const notify = vi.fn(async () => {
      throw new Error("push boom");
    });

    await processIngestionBatch(messages, { ingest, notify });

    expect(notify).toHaveBeenCalledTimes(2);
    expect(messages[0]?.ack).toHaveBeenCalledTimes(1);
    expect(messages[1]?.ack).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[cron:queue] notification push a levé"),
      "feed-1",
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it("route un message mode:backfill vers deps.backfill, jamais vers ingest ni notify (#97)", async () => {
    const ingest = vi.fn(async (feedId: string) => ingestResult({ feedId }));
    const backfill = vi.fn(async (feedId: string) =>
      backfillResult({ feedId, rewritten: 3 }),
    );
    const notify = vi.fn(async () => {});

    const message = makeMessage({
      feedId: "feed-1",
      mode: "backfill" as const,
    });
    await processIngestionBatch([message], { ingest, backfill, notify });

    expect(backfill).toHaveBeenCalledTimes(1);
    expect(backfill).toHaveBeenCalledWith("feed-1");
    expect(ingest).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it("route un message sans mode vers l'ingestion (rétro-compat) (#97)", async () => {
    const ingest = vi.fn(async (feedId: string) => ingestResult({ feedId }));
    const backfill = vi.fn(async (feedId: string) =>
      backfillResult({ feedId }),
    );

    await processIngestionBatch([makeMessage({ feedId: "feed-1" })], {
      ingest,
      backfill,
    });

    expect(ingest).toHaveBeenCalledTimes(1);
    expect(backfill).not.toHaveBeenCalled();
  });

  it("ack un message backfill sans deps.backfill mais logue l'absence de handler (#97)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ingest = vi.fn(async (feedId: string) => ingestResult({ feedId }));
    const message = makeMessage({
      feedId: "feed-1",
      mode: "backfill" as const,
    });

    await processIngestionBatch([message], { ingest });

    expect(ingest).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("sans handler backfill"),
      "feed-1",
    );
    errorSpy.mockRestore();
  });

  it("ack tout de même un message backfill en erreur, et le logue (#97)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ingest = vi.fn(async (feedId: string) => ingestResult({ feedId }));
    const backfill = vi.fn(async (feedId: string) =>
      backfillResult({ feedId, status: "error", error: "feed_not_found" }),
    );
    const message = makeMessage({
      feedId: "feed-1",
      mode: "backfill" as const,
    });

    await processIngestionBatch([message], { ingest, backfill });

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[cron:queue] backfill en erreur"),
      expect.objectContaining({ feedId: "feed-1", error: "feed_not_found" }),
    );
    errorSpy.mockRestore();
  });
});

describe("runScheduledTick", () => {
  const db = getDb(env.DB);

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM articles").run();
    await env.DB.prepare("DELETE FROM feeds").run();
  });

  /** Insère un Feed avec une échéance / un état d'abonnement contrôlés. */
  async function seedFeed(opts: {
    id: string;
    nextCheckAt?: string | null;
    unsubscribedAt?: string | null;
  }): Promise<void> {
    await env.DB.prepare(
      "INSERT INTO feeds (id, url, title, next_check_at, unsubscribed_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(
        opts.id,
        `https://src.example/${opts.id}.xml`,
        opts.id,
        opts.nextCheckAt ?? null,
        opts.unsubscribedAt ?? null,
      )
      .run();
  }

  it("enqueue exactement les ids des Feeds dus (échus ou jamais vérifiés)", async () => {
    await seedFeed({ id: "due-null", nextCheckAt: null });
    await seedFeed({ id: "due-past", nextCheckAt: "2020-01-01 00:00:00" });
    await seedFeed({ id: "not-due", nextCheckAt: "2099-01-01 00:00:00" });
    await seedFeed({
      id: "unsubscribed",
      nextCheckAt: null,
      unsubscribedAt: "2026-01-01 00:00:00",
    });

    const sendBatch = vi.fn(async () => {});
    await runScheduledTick(db, { sendBatch }, env.BUCKET);

    expect(sendBatch).toHaveBeenCalledTimes(1);
    const enqueued = sendBatch.mock.calls[0]?.[0] as Array<{
      body: { feedId: string };
    }>;
    expect(enqueued.map((m) => m.body.feedId).sort()).toEqual([
      "due-null",
      "due-past",
    ]);
  });
});
