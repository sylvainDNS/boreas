import { env } from "cloudflare:test";
import { getDb, type IngestResult } from "@boreas/shared";
import type { VapidKeys } from "@boreas/shared/crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildArticleNotificationPayload,
  notifyNewArticles,
} from "../src/push-notify";

function bytesToBase64url(b: ArrayBuffer): string {
  return Buffer.from(new Uint8Array(b)).toString("base64url");
}

/** Paire VAPID P-256 jetable (privée PKCS#8 + publique point brut, base64url). */
async function generateVapid(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  return {
    privateKey: bytesToBase64url(
      (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
    ),
    publicKey: bytesToBase64url(
      (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
    ),
    subject: "mailto:ops@boreas.test",
  };
}

/**
 * Clés **receveur** d'un abonnement, générées à la volée (clé publique ECDH P-256
 * brute + secret d'auth 16 o) : un abonnement valide pour que le chiffrement
 * aboutisse réellement, sans coder de chaîne haute-entropie en dur dans le repo.
 */
async function generateReceiverKeys(): Promise<{
  p256dh: string;
  auth: string;
}> {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  )) as CryptoKeyPair;
  const raw = (await crypto.subtle.exportKey(
    "raw",
    pair.publicKey,
  )) as ArrayBuffer;
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { p256dh: bytesToBase64url(raw), auth: bytesToBase64url(auth.buffer) };
}

/** Abonnement receveur courant (régénéré avant chaque cas, cf. beforeEach). */
let receiver: { p256dh: string; auth: string };

function result(overrides: Partial<IngestResult> = {}): IngestResult {
  return {
    feedId: "feed-1",
    status: "updated",
    inserted: 1,
    newArticleTitles: ["Premier article"],
    itemCount: 1,
    title: "Mon flux",
    consecutiveFailures: 0,
    ...overrides,
  };
}

async function seedSubscription(endpoint: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES (?, ?, ?)",
  )
    .bind(endpoint, receiver.p256dh, receiver.auth)
    .run();
}

async function listEndpoints(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT endpoint FROM push_subscriptions ORDER BY endpoint",
  ).all<{ endpoint: string }>();
  return results.map((r) => r.endpoint);
}

describe("buildArticleNotificationPayload (#80)", () => {
  it("un seul net-new : corps = titre, sans « +N autres »", () => {
    const payload = buildArticleNotificationPayload(
      result({
        feedId: "f1",
        title: "Le Monde",
        inserted: 1,
        newArticleTitles: ["Titre A"],
      }),
    );
    expect(payload).toEqual({
      title: "Le Monde",
      body: "Titre A",
      tag: "f1",
      url: "/feeds/f1",
    });
  });

  it("plusieurs net-new : « +N autres » au pluriel", () => {
    const payload = buildArticleNotificationPayload(
      result({ inserted: 3, newArticleTitles: ["A", "B", "C"] }),
    );
    expect(payload.body).toBe("A +2 autres");
  });

  it("deux net-new : « +1 autre » au singulier", () => {
    const payload = buildArticleNotificationPayload(
      result({ inserted: 2, newArticleTitles: ["A", "B"] }),
    );
    expect(payload.body).toBe("A +1 autre");
  });

  it("titre de flux absent → repli « Boréas »", () => {
    const payload = buildArticleNotificationPayload(
      result({ title: null, inserted: 1, newArticleTitles: ["A"] }),
    );
    expect(payload.title).toBe("Boréas");
  });

  it("net-new sans titre → repli « Nouvel article » + compte depuis inserted", () => {
    const payload = buildArticleNotificationPayload(
      result({ inserted: 2, newArticleTitles: [] }),
    );
    expect(payload.body).toBe("Nouvel article +1 autre");
  });
});

describe("notifyNewArticles (#80)", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM push_subscriptions").run();
    receiver = await generateReceiverKeys();
  });

  it("envoie un push à chaque abonné (payload chiffré aes128gcm)", async () => {
    await seedSubscription("https://push.example/a");
    await seedSubscription("https://push.example/b");
    const vapid = await generateVapid();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }));

    await notifyNewArticles(result(), getDb(env.DB), vapid, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Encoding"]).toBe(
      "aes128gcm",
    );
    // Aucun abonnement valide n'est purgé.
    expect(await listEndpoints()).toEqual([
      "https://push.example/a",
      "https://push.example/b",
    ]);
  });

  it("purge l'abonnement périmé (410 Gone) et garde les autres", async () => {
    await seedSubscription("https://push.example/dead");
    await seedSubscription("https://push.example/live");
    const vapid = await generateVapid();
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith("/dead")
        ? new Response(null, { status: 410 })
        : new Response(null, { status: 201 }),
    );

    await notifyNewArticles(result(), getDb(env.DB), vapid, fetchImpl);

    expect(await listEndpoints()).toEqual(["https://push.example/live"]);
  });

  it("no-op quand il n'y a aucun abonné", async () => {
    const vapid = await generateVapid();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }));

    await notifyNewArticles(result(), getDb(env.DB), vapid, fetchImpl);

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
