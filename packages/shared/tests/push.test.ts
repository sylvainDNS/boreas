import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, pushSubscriptions } from "../src/db/index";
import { sendPushAndPrune } from "../src/push";

/**
 * Couverture du helper partagé `sendPushAndPrune` (#92) : on vérifie
 * l'orchestration « envoi best-effort + purge sur gone », pas le chiffrement
 * (couvert par crypto-web-push.test.ts). La DB est mockée (env de test = node,
 * pas de D1) ; `fetchImpl` pilote le statut renvoyé par le service push.
 */

function bytesToBase64url(b: ArrayBuffer | Uint8Array): string {
  return Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString(
    "base64url",
  );
}

/** Paire VAPID P-256 jetable : privée PKCS#8 + publique point brut, base64url. */
async function generateVapidKeyPair() {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = (await crypto.subtle.exportKey(
    "pkcs8",
    pair.privateKey,
  )) as ArrayBuffer;
  const raw = (await crypto.subtle.exportKey(
    "raw",
    pair.publicKey,
  )) as ArrayBuffer;
  return {
    privateKey: bytesToBase64url(pkcs8),
    publicKey: bytesToBase64url(raw),
    subject: "mailto:ops@boreas.test",
  };
}

const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc123";

/**
 * Clés d'abonné jetables, générées au runtime : `p256dh` = point public ECDH
 * P-256 brut (base64url), `auth` = 16 octets aléatoires. Suffisent à `sendWebPush`
 * pour chiffrer un corps valide, sans littéral à haute entropie en clair.
 */
async function generateSubscriberKeys() {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  )) as CryptoKeyPair;
  const raw = (await crypto.subtle.exportKey(
    "raw",
    pair.publicKey,
  )) as ArrayBuffer;
  return {
    p256dh: bytesToBase64url(raw),
    auth: bytesToBase64url(crypto.getRandomValues(new Uint8Array(16))),
  };
}

/** DB factrice : enregistre les `delete(...).where(...)` sans toucher à D1. */
function makeFakeDb() {
  const where = vi.fn(async () => {});
  const del = vi.fn(() => ({ where }));
  return { db: { delete: del } as unknown as Db, del, where };
}

describe("sendPushAndPrune (#92)", () => {
  let subscription: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  };

  beforeEach(async () => {
    subscription = { endpoint: ENDPOINT, keys: await generateSubscriberKeys() };
  });

  // Restaure les spies (ex. `console.error`) même si une assertion échoue —
  // sinon un mock global fuiterait sur les tests suivants.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("envoie le push à l'endpoint et ne purge rien sur 201", async () => {
    const vapid = await generateVapidKeyPair();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }));
    const { db, del } = makeFakeDb();

    const result = await sendPushAndPrune(db, subscription, "coucou", vapid, {
      fetchImpl,
    });

    expect(result).toMatchObject({ ok: true, status: 201, gone: false });
    // L'envoi vise bien l'endpoint de l'abonné (pas seulement « fetch a eu lieu »).
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(subscription.endpoint);
    expect(del).not.toHaveBeenCalled();
  });

  it("purge l'abonnement périmé sur 410 (gone)", async () => {
    const vapid = await generateVapidKeyPair();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 410 }));
    const { db, del, where } = makeFakeDb();

    const result = await sendPushAndPrune(db, subscription, "coucou", vapid, {
      fetchImpl,
    });

    expect(result).toMatchObject({ ok: false, status: 410, gone: true });
    // La purge cible bien la table des abonnements (pas une autre table/colonne).
    expect(del).toHaveBeenCalledOnce();
    expect(del).toHaveBeenCalledWith(pushSubscriptions);
    expect(where).toHaveBeenCalledOnce();
  });

  it("ne purge pas sur une erreur transitoire non-gone (500)", async () => {
    // Frontière clé : seul 404/410 purge. Un 5xx est transitoire — l'abonnement
    // reste, sinon une panne du service push détruirait tous les abonnements.
    const vapid = await generateVapidKeyPair();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }));
    const { db, del } = makeFakeDb();

    const result = await sendPushAndPrune(db, subscription, "coucou", vapid, {
      fetchImpl,
    });

    expect(result).toMatchObject({ ok: false, status: 500, gone: false });
    expect(del).not.toHaveBeenCalled();
  });

  it("avale l'erreur d'envoi, retourne null et ne purge pas", async () => {
    const vapid = await generateVapidKeyPair();
    const fetchImpl = vi.fn(async () => {
      throw new Error("réseau coupé");
    });
    const { db, del } = makeFakeDb();
    // Restauré par l'`afterEach` (vi.restoreAllMocks), même si une assertion échoue.
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const result = await sendPushAndPrune(db, subscription, "coucou", vapid, {
      fetchImpl,
      label: "test échoué",
    });

    expect(result).toBeNull();
    expect(del).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      "test échoué",
      subscription.endpoint,
      expect.any(Error),
    );
  });
});
