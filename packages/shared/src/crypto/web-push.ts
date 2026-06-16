/**
 * Web Push depuis un Worker Cloudflare (#79, ADR 0018) — **WebCrypto pur**
 * (`crypto.subtle`), zéro dépendance. Verdict du spike #78 (GO) : toutes les
 * primitives requises sont supportées par workerd ET Node, d'où des tests
 * exécutables hors-Worker.
 *
 * Deux briques :
 *  - **VAPID** (RFC 8292) : JWT ES256 (ECDSA P-256) identifiant le serveur push
 *    auprès du service (FCM/Mozilla…).
 *  - **Chiffrement `aes128gcm`** (RFC 8291 sur le content-coding RFC 8188) : le
 *    payload est chiffré pour l'abonné avant envoi.
 *
 * Module **serveur uniquement** (api + cron) ; le front a sa propre plomberie
 * (`apps/web/src/lib/push.ts`).
 */

/** Encode des octets en base64url (sans padding). */
function bytesToBase64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Buffer.from(view).toString("base64url");
}

/** Concatène des suites d'octets en un seul `Uint8Array`. */
function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** `label || 0x00` — patron des `info` HKDF de RFC 8188. */
function codingInfo(label: string): Uint8Array {
  return concatBytes(new TextEncoder().encode(label), new Uint8Array([0]));
}

/**
 * HKDF-SHA256 (extract + expand). `crypto.subtle` gère le compteur `0x01` de
 * l'expand en interne ; on ne passe donc que le préfixe d'`info`.
 */
async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/** Taille de record RFC 8188 — on n'émet qu'un record unique (web push). */
const RECORD_SIZE = 4096;
/** Longueur d'un point P-256 non compressé (`0x04 || X || Y`). */
const P256_PUBLIC_LEN = 65;

/** Sérialise un objet JSON puis l'encode en base64url (segment de JWT). */
function jsonToBase64url(value: object): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** Durée de vie par défaut d'un JWT VAPID (12 h) ; le plafond RFC 8292 est 24 h. */
const VAPID_TTL_SECONDS = 12 * 60 * 60;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Forge un **JWT VAPID** (RFC 8292) signé ES256.
 *
 * - `audience` : origine du service push (`https://fcm.googleapis.com`…), claim `aud`.
 * - `subject` : contact (`mailto:` ou URL), claim `sub`.
 * - `privateKey` : clé privée VAPID au format **PKCS#8 base64url** (secret Worker).
 * - `now` : epoch (s) injectable pour des tests déterministes.
 *
 * `crypto.subtle.sign(ECDSA)` renvoie la signature au format **JOSE `r‖s`** (64 o),
 * exactement ce qu'attend un JWT — aucun ré-encodage DER nécessaire.
 */
export async function createVapidJwt(params: {
  audience: string;
  subject: string;
  privateKey: string;
  now?: number;
  expiresIn?: number;
}): Promise<string> {
  const now = params.now ?? nowSeconds();
  const exp = now + (params.expiresIn ?? VAPID_TTL_SECONDS);

  const header = jsonToBase64url({ typ: "JWT", alg: "ES256" });
  const payload = jsonToBase64url({
    aud: params.audience,
    exp,
    sub: params.subject,
  });
  const signingInput = `${header}.${payload}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    Buffer.from(params.privateKey, "base64url"),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${bytesToBase64url(signature)}`;
}

/**
 * Chiffre `payload` pour un abonné en **`aes128gcm`** (RFC 8291 sur le
 * content-coding RFC 8188), en un **record unique**.
 *
 * - `p256dh` : clé publique de l'abonné (point brut, base64url).
 * - `auth` : secret d'auth de l'abonné (base64url).
 * - `salt` / `serverKeys` : injectables pour reproduire un vecteur de test ;
 *   sinon un sel de 16 o et une paire ECDH P-256 **éphémère** sont tirés au sort.
 *
 * Dérivation (RFC 8291 §3.4) : `ecdh = ECDH(serverPriv, ua_public)` ; `IKM =
 * HKDF(salt=auth, ikm=ecdh, info="WebPush: info"\0‖ua_public‖as_public)` ; puis
 * `CEK`/`NONCE = HKDF(salt, IKM, "Content-Encoding: …"\0)`. Le clair reçoit un
 * délimiteur `0x02` (dernier record, RFC 8188) avant AES-128-GCM.
 *
 * Renvoie le corps complet : `salt(16)‖rs(4)‖idlen(1)‖as_public(65)‖ciphertext`.
 */
export async function encryptPayload(params: {
  payload: Uint8Array | string;
  p256dh: string;
  auth: string;
  salt?: Uint8Array;
  serverKeys?: CryptoKeyPair;
}): Promise<Uint8Array> {
  const plaintext =
    typeof params.payload === "string"
      ? new TextEncoder().encode(params.payload)
      : params.payload;
  const salt = params.salt ?? crypto.getRandomValues(new Uint8Array(16));
  // `generateKey` est typé en union par workers-types : on désambiguïse en paire.
  const serverKeys = (params.serverKeys ??
    (await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    ))) as CryptoKeyPair;

  const uaPublic = new Uint8Array(Buffer.from(params.p256dh, "base64url"));
  const authSecret = new Uint8Array(Buffer.from(params.auth, "base64url"));
  const asPublic = new Uint8Array(
    (await crypto.subtle.exportKey("raw", serverKeys.publicKey)) as ArrayBuffer,
  );

  // Secret partagé ECDH (serveur éphémère × abonné). Le champ standard WebCrypto
  // est `public` (validé par le vecteur RFC 8291) ; workers-types le déclare
  // `$public`, d'où le cast pour réconcilier types et runtime.
  const uaPublicKey = await crypto.subtle.importKey(
    "raw",
    uaPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "ECDH",
        public: uaPublicKey,
      } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      serverKeys.privateKey,
      256,
    ),
  );

  // IKM combiné (RFC 8291) puis CEK/NONCE (RFC 8188) à partir du sel.
  const keyInfo = concatBytes(codingInfo("WebPush: info"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(
    salt,
    ikm,
    codingInfo("Content-Encoding: aes128gcm"),
    16,
  );
  const nonce = await hkdf(
    salt,
    ikm,
    codingInfo("Content-Encoding: nonce"),
    12,
  );

  // Record unique et dernier : clair + délimiteur 0x02 (RFC 8188 §2.1).
  const padded = concatBytes(plaintext, new Uint8Array([0x02]));
  const aesKey = await crypto.subtle.importKey(
    "raw",
    cek,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, tagLength: 128 },
      aesKey,
      padded,
    ),
  );

  // En-tête RFC 8188 : salt || rs (BE) || idlen || keyid(=as_public).
  const header = new Uint8Array(16 + 4 + 1 + P256_PUBLIC_LEN);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE, false);
  header[20] = P256_PUBLIC_LEN;
  header.set(asPublic, 21);

  return concatBytes(header, ciphertext);
}

/** Abonnement push tel que sérialisé par le navigateur (`PushSubscription.toJSON()`). */
export interface WebPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Clés VAPID du serveur push (publique pour `k=`, privée pour signer le JWT). */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/**
 * Assemble les `VapidKeys` depuis l'environnement Worker (privée = secret).
 * Source unique du mapping `env → VapidKeys`, partagée par l'API et le Cron
 * (#92) : le type est structurel, n'importe quel `Env` exposant les 3 champs
 * convient.
 */
export function vapidKeysFromEnv(env: {
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;
}): VapidKeys {
  return {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT,
  };
}

/** Requête HTTP prête à POSTer vers le service push. */
export interface WebPushRequest {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** Durée de rétention par défaut d'un message côté service push (4 semaines). */
const DEFAULT_TTL_SECONDS = 4 * 7 * 24 * 60 * 60;

/**
 * Assemble la requête HTTP d'un Web Push (#79) : URL = endpoint, corps chiffré
 * `aes128gcm`, en-tête `Authorization: vapid t=<jwt>,k=<clé publique>` (RFC 8292).
 * L'`aud` du JWT est l'**origine** du service push.
 *
 * `options.salt`/`serverKeys`/`now` sont injectables (tests déterministes).
 */
export async function buildWebPushRequest(
  subscription: WebPushSubscription,
  payload: Uint8Array | string,
  vapid: VapidKeys,
  options?: {
    ttl?: number;
    salt?: Uint8Array;
    serverKeys?: CryptoKeyPair;
    now?: number;
  },
): Promise<WebPushRequest> {
  const audience = new URL(subscription.endpoint).origin;
  const jwt = await createVapidJwt({
    audience,
    subject: vapid.subject,
    privateKey: vapid.privateKey,
    now: options?.now,
  });
  const body = await encryptPayload({
    payload,
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth,
    salt: options?.salt,
    serverKeys: options?.serverKeys,
  });

  return {
    url: subscription.endpoint,
    headers: {
      Authorization: `vapid t=${jwt},k=${vapid.publicKey}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(options?.ttl ?? DEFAULT_TTL_SECONDS),
    },
    body,
  };
}

/** Issue d'un envoi push. `gone` = abonnement à purger (404/410). */
export interface SendResult {
  ok: boolean;
  status: number;
  gone: boolean;
}

/**
 * Envoie un Web Push (#79). `fetchImpl` est injectable (tests / `fetch` lié au
 * Worker). Un statut **404/410** signale un abonnement expiré côté service push :
 * `gone` permet à l'appelant de supprimer la ligne `push_subscriptions`.
 */
export async function sendWebPush(
  subscription: WebPushSubscription,
  payload: Uint8Array | string,
  vapid: VapidKeys,
  options?: {
    ttl?: number;
    salt?: Uint8Array;
    serverKeys?: CryptoKeyPair;
    now?: number;
    fetchImpl?: typeof fetch;
  },
): Promise<SendResult> {
  const req = await buildWebPushRequest(subscription, payload, vapid, options);
  const doFetch = options?.fetchImpl ?? fetch;
  const res = await doFetch(req.url, {
    method: "POST",
    headers: req.headers,
    body: req.body,
  });
  return {
    ok: res.ok,
    status: res.status,
    gone: res.status === 404 || res.status === 410,
  };
}
