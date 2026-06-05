import { createHmac, timingSafeEqual } from "node:crypto";

/** HMAC-SHA256 d'une chaîne, encodé base64url. Primitive partagée (jetons, URLs d'images signées). */
export function hmacBase64url(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

/**
 * Compare deux signatures en temps constant. La vérification de longueur
 * précède `timingSafeEqual` (qui lève si les tailles diffèrent).
 */
export function signaturesMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
