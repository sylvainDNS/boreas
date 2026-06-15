import { describe, expect, it, vi } from "vitest";
import {
  buildWebPushRequest,
  createVapidJwt,
  encryptPayload,
  sendWebPush,
} from "../src/crypto/web-push";

/** epoch (secondes) fixe pour des assertions d'expiration déterministes. */
const NOW = 1_800_000_000;

function bytesToBase64url(b: ArrayBuffer | Uint8Array): string {
  return Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString(
    "base64url",
  );
}

function base64urlToBytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64url"));
}

/** Génère une paire ECDSA P-256 (le type WebCrypto est une union à désambiguïser). */
async function generateEcdsaKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
}

/** Paire VAPID P-256 jetable : privée PKCS#8 base64url + publique brute (CryptoKey). */
async function generateVapidKeys() {
  const pair = await generateEcdsaKeyPair();
  const pkcs8 = (await crypto.subtle.exportKey(
    "pkcs8",
    pair.privateKey,
  )) as ArrayBuffer;
  return { privateKey: bytesToBase64url(pkcs8), publicKey: pair.publicKey };
}

/** Paire VAPID complète : privée PKCS#8 + publique point brut, en base64url. */
async function generateVapidKeyPair() {
  const pair = await generateEcdsaKeyPair();
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

function decodeJwt(jwt: string) {
  const [header, payload, signature] = jwt.split(".");
  if (!header || !payload || !signature) throw new Error("JWT malformé");
  return {
    header: JSON.parse(Buffer.from(header, "base64url").toString("utf8")),
    payload: JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    signingInput: `${header}.${payload}`,
    signature: base64urlToBytes(signature),
  };
}

describe("createVapidJwt (#79, VAPID RFC 8292)", () => {
  it("produit un JWT ES256 signé, vérifiable avec la clé publique", async () => {
    const keys = await generateVapidKeys();

    const jwt = await createVapidJwt({
      audience: "https://fcm.googleapis.com",
      subject: "mailto:ops@boreas.test",
      privateKey: keys.privateKey,
      now: NOW,
    });

    const { header, payload, signingInput, signature } = decodeJwt(jwt);
    expect(header).toEqual({ typ: "JWT", alg: "ES256" });
    expect(payload.aud).toBe("https://fcm.googleapis.com");
    expect(payload.sub).toBe("mailto:ops@boreas.test");
    expect(payload.exp).toBeGreaterThan(NOW);
    // RFC 8292 : `exp` au plus 24 h dans le futur (FCM rejette au-delà).
    expect(payload.exp).toBeLessThanOrEqual(NOW + 24 * 60 * 60);

    // Signature JOSE = r‖s sur 64 octets (pas DER), vérifiable ECDSA P-256/SHA-256.
    expect(signature.length).toBe(64);
    const verified = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      keys.publicKey,
      signature,
      new TextEncoder().encode(signingInput),
    );
    expect(verified).toBe(true);
  });
});

/**
 * Vecteur de l'exemple **RFC 8291 §5** (« Push Message Encryption Example »).
 * `asPrivate`/`asPublic` = paire **ECDH éphémère** du serveur (≠ paire VAPID).
 */
const RFC8291 = {
  plaintext: "When I grow up, I want to be a watermelon",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  uaPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic:
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  expected:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

/** Reconstruit une paire ECDH P-256 à partir des octets bruts (scalaire + point). */
async function importServerEcdhKeys(
  privateScalar: string,
  publicPoint: string,
): Promise<CryptoKeyPair> {
  const pub = base64urlToBytes(publicPoint); // 0x04 || X(32) || Y(32)
  const x = bytesToBase64url(pub.slice(1, 33));
  const y = bytesToBase64url(pub.slice(33, 65));
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", d: privateScalar, x, y, ext: true },
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x, y, ext: true },
    { name: "ECDH", namedCurve: "P-256" },
    true,
    [],
  );
  return { privateKey, publicKey };
}

describe("encryptPayload (#79, aes128gcm RFC 8291/8188)", () => {
  it("reproduit le vecteur de chiffrement RFC 8291 §5", async () => {
    const serverKeys = await importServerEcdhKeys(
      RFC8291.asPrivate,
      RFC8291.asPublic,
    );

    const body = await encryptPayload({
      payload: RFC8291.plaintext,
      p256dh: RFC8291.uaPublic,
      auth: RFC8291.authSecret,
      salt: base64urlToBytes(RFC8291.salt),
      serverKeys,
    });

    expect(bytesToBase64url(body)).toBe(RFC8291.expected);
  });

  it("compose un corps RFC 8188 valide avec sel et paire aléatoires", async () => {
    const body = await encryptPayload({
      payload: "coucou",
      p256dh: RFC8291.uaPublic,
      auth: RFC8291.authSecret,
    });

    // En-tête : salt(16) || rs(4) || idlen(1) || keyid(65=0x41) || ciphertext.
    expect(body[20]).toBe(0x41);
    // ciphertext = plaintext(6) + délimiteur(1) + tag GCM(16) = 23 ; en-tête = 86.
    expect(body.length).toBe(16 + 4 + 1 + 65 + (6 + 1 + 16));
  });
});

describe("buildWebPushRequest (#79)", () => {
  it("assemble l'URL, les en-têtes VAPID et le corps chiffré", async () => {
    const vapid = await generateVapidKeyPair();
    const subscription = {
      endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
      keys: { p256dh: RFC8291.uaPublic, auth: RFC8291.authSecret },
    };

    const req = await buildWebPushRequest(subscription, "coucou", vapid);

    expect(req.url).toBe(subscription.endpoint);
    expect(req.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(req.headers.TTL).toBeDefined();

    const auth = req.headers.Authorization ?? "";
    expect(auth).toMatch(/^vapid t=[^,]+,k=.+$/);
    const t = auth.slice("vapid t=".length, auth.indexOf(",k="));
    const k = auth.slice(auth.indexOf(",k=") + 3);
    expect(k).toBe(vapid.publicKey);
    // `aud` du JWT = origine du service push (pas le chemin complet).
    const claims = JSON.parse(
      Buffer.from(t.split(".")[1] ?? "", "base64url").toString("utf8"),
    );
    expect(claims.aud).toBe("https://fcm.googleapis.com");

    // Corps = en-tête RFC 8188 (86 o) + ciphertext non vide.
    expect(req.body.length).toBeGreaterThan(86);
  });
});

describe("sendWebPush (#79)", () => {
  const subscription = {
    endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
    keys: { p256dh: RFC8291.uaPublic, auth: RFC8291.authSecret },
  };

  it("POSTe vers l'endpoint et renvoie ok sur 201", async () => {
    const vapid = await generateVapidKeyPair();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }));

    const res = await sendWebPush(subscription, "coucou", vapid, { fetchImpl });

    expect(res).toMatchObject({ ok: true, status: 201, gone: false });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(subscription.endpoint);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Encoding"]).toBe(
      "aes128gcm",
    );
  });

  it("signale un abonnement disparu sur 410 (à purger)", async () => {
    const vapid = await generateVapidKeyPair();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 410 }));

    const res = await sendWebPush(subscription, "coucou", vapid, { fetchImpl });

    expect(res).toMatchObject({ ok: false, status: 410, gone: true });
  });
});
