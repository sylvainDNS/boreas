import { authTokens, getDb, settings } from "@boreas/shared";
import { issueMagicToken, verifyMagicToken } from "@boreas/shared/crypto";
import { and, eq, gt } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { sendMagicLink } from "../lib/email";
import {
  clearSessionCookie,
  hasValidSession,
  setSessionCookie,
} from "../lib/session";

const requestSchema = z.object({ email: z.string().email() });

/**
 * Routes d'auth magic link (montées sur /api/auth). Toutes publiques :
 * elles précèdent volontairement le middleware de session dans index.ts.
 */
export const authRoutes = new Hono<{ Bindings: Env }>();

/**
 * Demande de lien. Réponse 200 générique quelle que soit l'issue
 * (anti-énumération) : un lien n'est réellement émis que pour l'`allowed_email`.
 */
authRoutes.post("/request", async (c) => {
  const parsed = requestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "invalid_request" }, 400);
  }

  const db = getDb(c.env.DB);
  const [row] = await db
    .select({ allowed: settings.allowed_email })
    .from(settings)
    .limit(1);

  if (row?.allowed === parsed.data.email) {
    try {
      const { token, tokenHash, expiresAt } = issueMagicToken(
        c.env.HMAC_SECRET,
      );
      await db
        .insert(authTokens)
        .values({ token_hash: tokenHash, expires_at: expiresAt });
      const base = c.env.APP_BASE_URL.replace(/\/+$/, "");
      const link = `${base}/api/auth/verify?token=${encodeURIComponent(token)}`;
      // Envoi en arrière-plan : la réponse reste à temps constant, sans attendre
      // l'API e-mail (~2 s) — pas d'oracle de timing révélant l'adresse autorisée.
      c.executionCtx.waitUntil(
        sendMagicLink(c.env, parsed.data.email, link).catch((err) => {
          console.error("[auth] échec d'envoi du magic link", err);
        }),
      );
    } catch (err) {
      // Une erreur interne (D1…) ne doit jamais différencier la réponse selon
      // l'adresse : on logge et on retombe sur la réponse générique.
      console.error("[auth] échec d'émission du magic link", err);
    }
  }

  // Réponse générique identique quelle que soit l'adresse (anti-énumération).
  return c.json({ status: "ok" });
});

/**
 * Vérification du lien : signature + expiration, puis consommation atomique en
 * D1 (l'UPDATE conditionnel sur `used=0 AND expires_at>now` garantit l'usage
 * unique — un second clic concurrent touche 0 ligne). En cas de succès, pose la
 * session et redirige vers l'app.
 */
authRoutes.get("/verify", async (c) => {
  const token = c.req.query("token");
  if (!token) return c.json({ error: "invalid_token" }, 400);

  const verified = verifyMagicToken(c.env.HMAC_SECRET, token);
  if (!verified.ok) return c.json({ error: "invalid_token" }, 400);

  const db = getDb(c.env.DB);
  const now = Math.floor(Date.now() / 1000);
  const consumed = await db
    .update(authTokens)
    .set({ used: true })
    .where(
      and(
        eq(authTokens.token_hash, verified.tokenHash),
        eq(authTokens.used, false),
        gt(authTokens.expires_at, now),
      ),
    )
    .returning({ hash: authTokens.token_hash });

  if (consumed.length === 0) return c.json({ error: "invalid_token" }, 400);

  setSessionCookie(c, c.env.HMAC_SECRET);
  return c.redirect("/", 302);
});

/** Coupe la session sur l'appareil courant. */
authRoutes.post("/logout", (c) => {
  clearSessionCookie(c);
  return c.body(null, 204);
});

/** État de session pour le guard du SPA. */
authRoutes.get("/session", (c) => {
  if (!hasValidSession(c, c.env.HMAC_SECRET)) {
    return c.json({ authenticated: false }, 401);
  }
  return c.json({ authenticated: true });
});
