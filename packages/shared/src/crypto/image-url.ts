import { createHash } from "node:crypto";
import { hmacBase64url, signaturesMatch } from "./hmac";

/**
 * URLs d'images signées HMAC pour le proxy `/api/img` (ADR 0009).
 *
 * À la sanitization (ADR 0007), chaque `src` d'image http(s) est réécrit vers le
 * proxy avec sa source encodée et une signature : `/api/img?u=<b64url(src)>&sig=`.
 * La signature porte sur `u` (valeur exacte du paramètre) ; le proxy (#16) ne
 * sert que des URLs pré-validées, ce qui neutralise le SSRF. Le secret est
 * mutualisé avec l'auth (ADR 0005).
 */

const IMG_PROXY_PATH = "/api/img";

/** Signe une URL source absolue et renvoie le chemin proxy correspondant. */
export function signImageUrl(secret: string, srcUrl: string): string {
  const u = Buffer.from(srcUrl, "utf8").toString("base64url");
  const sig = hmacBase64url(secret, u);
  return `${IMG_PROXY_PATH}?u=${u}&sig=${sig}`;
}

/**
 * Vérifie un couple `(u, sig)` et renvoie l'URL source décodée, ou `null` si la
 * signature est absente/falsifiée. Destiné au proxy d'images (#16).
 */
export function verifyImageUrl(
  secret: string,
  u: string,
  sig: string,
): string | null {
  if (!u || !sig) return null;
  if (!signaturesMatch(sig, hmacBase64url(secret, u))) return null;
  try {
    return Buffer.from(u, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Clé R2 d'une image proxifiée (ADR 0009) : content-addressed par l'URL source,
 * `images/<sha256hex(srcUrl)>`. Deux articles citant la même image partagent
 * donc le même objet cache. Déterministe — utilisée à la fois pour lire le cache
 * et pour y écrire (#16).
 */
export function imageCacheKey(srcUrl: string): string {
  return `images/${createHash("sha256").update(srcUrl).digest("hex")}`;
}
