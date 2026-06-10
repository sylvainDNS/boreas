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

/**
 * Validation pure d'un jeton de session — sans Hono, testable sans route HTTP.
 * Délègue la signature et l'expiration à `verifySession` ; `now` (epoch s) est
 * injectable pour des tests d'expiration déterministes.
 */
export function isValidSessionToken(
  secret: string,
  token: string | undefined,
  now?: number,
): boolean {
  if (!token) return false;
  return verifySession(secret, token, now).ok;
}

/**
 * Adapter Hono : lit le cookie de session et délègue la validation à
 * `isValidSessionToken`. Vrai si la requête porte un cookie valide
 * (signature + expiration).
 */
export function hasValidSession(c: Context, secret: string): boolean {
  return isValidSessionToken(secret, getCookie(c, SESSION_COOKIE));
}
