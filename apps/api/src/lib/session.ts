import {
  issueSession,
  SESSION_TTL_SECONDS,
  verifySession,
} from "@boreas/shared/crypto";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

/** Nom du cookie de session. */
export const SESSION_COOKIE = "boreas_session";

/**
 * Pose le cookie de session signé. `Secure` est toujours actif (accepté par les
 * navigateurs sur `localhost` même en http) ; `SameSite=Strict` suffit à se
 * passer de CORS puisque l'API partage l'origine du SPA (ADR 0008).
 */
export function setSessionCookie(c: Context, secret: string): void {
  setCookie(c, SESSION_COOKIE, issueSession(secret), {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

/** Supprime le cookie de session (logout). */
export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

/** Vrai si la requête porte un cookie de session valide (signature + expiration). */
export function hasValidSession(c: Context, secret: string): boolean {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return false;
  return verifySession(secret, token).ok;
}
