import {
  type PushNotificationPayload,
  pushSubscriptionSchema,
  pushUnsubscribeSchema,
} from "@boreas/api-contracts";
import { getDb, pushSubscriptions } from "@boreas/shared";
import { sendWebPush, type VapidKeys } from "@boreas/shared/crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Env } from "../env";

/**
 * Abonnement Web Push (#79, ADR 0018). Monté sur /api/push, sous la garde de
 * session. App mono-utilisateur : pas de `user_id`, l'`endpoint` identifie un
 * appareil abonné.
 *
 * À l'abonnement, on émet aussitôt une **notification de test** (push de
 * bienvenue) : c'est le chemin de validation bout-en-bout demandé par #79 (le
 * handler `push` du SW l'affiche). Cet envoi est **best-effort** — il ne fait
 * jamais échouer l'enregistrement ; un endpoint déjà mort (404/410) est purgé.
 */
export const pushRoutes = new Hono<{ Bindings: Env }>();

/** Clés VAPID assemblées depuis l'environnement (privée = secret Worker). */
function vapidKeys(env: Env): VapidKeys {
  return {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT,
  };
}

/** Payload du push de bienvenue (= notification de test). Consommé par le SW. */
const WELCOME_PAYLOAD: PushNotificationPayload = {
  title: "Notifications activées",
  body: "Boréas vous préviendra dès qu'un article est prêt à lire.",
  tag: "boreas-welcome",
};

pushRoutes.post("/subscribe", async (c) => {
  const parsed = pushSubscriptionSchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return c.json({ error: "invalid_request" }, 400);
  }
  const { endpoint, keys } = parsed.data;
  const db = getDb(c.env.DB);

  // Upsert : réabonner le même endpoint rafraîchit ses clés (rotation navigateur).
  await db
    .insert(pushSubscriptions)
    .values({ endpoint, p256dh: keys.p256dh, auth: keys.auth })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { p256dh: keys.p256dh, auth: keys.auth },
    });

  // Notification de test, best-effort. Purge si l'endpoint est déjà périmé.
  // On loggue l'échec (Workers Logs activés) : sans cela, une mauvaise config
  // VAPID ferait disparaître le push de test en silence, indébogable.
  const result = await sendWebPush(
    { endpoint, keys },
    JSON.stringify(WELCOME_PAYLOAD),
    vapidKeys(c.env),
  ).catch((err) => {
    console.error("push de bienvenue échoué", err);
    return null;
  });
  if (result?.gone) {
    await db
      .delete(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, endpoint));
  }

  return c.json({ ok: true }, 201);
});

pushRoutes.delete("/subscribe", async (c) => {
  const parsed = pushUnsubscribeSchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return c.json({ error: "invalid_request" }, 400);
  }

  // Idempotent : supprimer un endpoint absent renvoie aussi 204 (le client veut
  // juste « ne plus être abonné », peu importe l'état serveur antérieur).
  const db = getDb(c.env.DB);
  await db
    .delete(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, parsed.data.endpoint));

  return c.body(null, 204);
});
