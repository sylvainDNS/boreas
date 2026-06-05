import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Jetons signés HMAC pour l'auth magic link (ADR 0005).
 *
 * Deux familles, même format : `base64url(payloadJSON).base64url(HMAC-SHA256)`.
 * - **Magic** (`{ exp, jti }`, ~10 min) : envoyé par e-mail, à usage unique. La
 *   signature protège de la falsification ; l'usage unique est garanti côté
 *   appelant via `tokenHash` stocké en D1 (le module reste pur, sans état).
 * - **Session** (`{ exp, sub }`, ~60 j) : cookie signé stateless, vérifié à
 *   chaque requête — aucune table.
 *
 * Le paramètre `now` (epoch s) est injectable pour des tests d'expiration
 * déterministes ; il vaut l'heure courante par défaut.
 */

/** Durée de vie d'un jeton magic link (secondes). */
export const MAGIC_TTL_SECONDS = 10 * 60;
/** Durée de vie d'une session (secondes) — ~60 jours. */
export const SESSION_TTL_SECONDS = 60 * 24 * 60 * 60;

/** Sujet unique des sessions (app mono-utilisateur). */
const SESSION_SUBJECT = "owner";

interface MagicPayload {
  exp: number;
  jti: string;
}

interface SessionPayload {
  exp: number;
  sub: string;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function encodePayload(payload: object): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function sign(secret: string, encodedPayload: string): string {
  return createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");
}

/**
 * Compare deux signatures en temps constant. La vérification de longueur
 * précède `timingSafeEqual` (qui lève si les tailles diffèrent).
 */
function signaturesMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function buildToken(secret: string, payload: object): string {
  const encoded = encodePayload(payload);
  return `${encoded}.${sign(secret, encoded)}`;
}

/**
 * Vérifie la signature et décode le payload. Renvoie `null` si le jeton est
 * malformé ou falsifié. Ne contrôle PAS l'expiration (laissée aux vérifieurs).
 */
function openToken(secret: string, token: string): { payload: unknown } | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const encoded = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!signaturesMatch(signature, sign(secret, encoded))) return null;
  try {
    const json = Buffer.from(encoded, "base64url").toString("utf8");
    return { payload: JSON.parse(json) as unknown };
  } catch {
    return null;
  }
}

function isMagicPayload(value: unknown): value is MagicPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as MagicPayload).exp === "number" &&
    typeof (value as MagicPayload).jti === "string"
  );
}

function isSessionPayload(value: unknown): value is SessionPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as SessionPayload).exp === "number" &&
    (value as SessionPayload).sub === SESSION_SUBJECT
  );
}

/** Empreinte stable d'un jeton (jamais le jeton en clair stocké en D1). */
export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface IssuedMagicToken {
  /** Jeton à placer dans le lien envoyé par e-mail. */
  token: string;
  /** Empreinte à stocker en D1 pour l'usage unique. */
  tokenHash: string;
  /** Expiration (epoch s). */
  expiresAt: number;
}

export function issueMagicToken(
  secret: string,
  ttlSeconds: number = MAGIC_TTL_SECONDS,
  now: number = nowSeconds(),
): IssuedMagicToken {
  const exp = now + ttlSeconds;
  const jti = randomBytes(16).toString("hex");
  const token = buildToken(secret, { exp, jti } satisfies MagicPayload);
  return { token, tokenHash: tokenHash(token), expiresAt: exp };
}

export type MagicVerification =
  | { ok: true; tokenHash: string; expiresAt: number }
  | { ok: false; reason: "malformed" | "expired" };

export function verifyMagicToken(
  secret: string,
  token: string,
  now: number = nowSeconds(),
): MagicVerification {
  const opened = openToken(secret, token);
  if (!opened || !isMagicPayload(opened.payload)) {
    return { ok: false, reason: "malformed" };
  }
  if (opened.payload.exp <= now) return { ok: false, reason: "expired" };
  return {
    ok: true,
    tokenHash: tokenHash(token),
    expiresAt: opened.payload.exp,
  };
}

export function issueSession(
  secret: string,
  ttlSeconds: number = SESSION_TTL_SECONDS,
  now: number = nowSeconds(),
): string {
  const exp = now + ttlSeconds;
  return buildToken(secret, {
    exp,
    sub: SESSION_SUBJECT,
  } satisfies SessionPayload);
}

export type SessionVerification =
  | { ok: true }
  | { ok: false; reason: "malformed" | "expired" };

export function verifySession(
  secret: string,
  token: string,
  now: number = nowSeconds(),
): SessionVerification {
  const opened = openToken(secret, token);
  if (!opened || !isSessionPayload(opened.payload)) {
    return { ok: false, reason: "malformed" };
  }
  if (opened.payload.exp <= now) return { ok: false, reason: "expired" };
  return { ok: true };
}
