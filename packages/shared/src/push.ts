/**
 * Cycle de vie d'un abonnement Web Push, côté serveur (#92, ADR 0018).
 *
 * Source unique de la politique « émettre un push best-effort + purger
 * l'endpoint périmé (404/410) », partagée par le push de bienvenue (API, #79) et
 * la notif d'ingestion (Cron, #80). Le crypto (`./crypto`) reste découplé de la
 * DB : c'est ici, au-dessus, que l'envoi est relié à `push_subscriptions`.
 */

import { eq } from "drizzle-orm";
import {
  type SendResult,
  sendWebPush,
  type VapidKeys,
  type WebPushSubscription,
} from "./crypto/index";
import { type Db, pushSubscriptions } from "./db/index";

/**
 * Émet un Web Push pour **un** abonnement et purge sa ligne `push_subscriptions`
 * s'il est périmé (404/410 → `gone`). L'envoi est **best-effort** : une erreur
 * réseau/chiffrement est loguée (préfixe `label`, pour déboguer une mauvaise
 * config VAPID) et avalée — l'appelant n'a jamais à la rattraper. Pour un
 * broadcast, l'appelant fan-out (ex. `Promise.all(subs.map(...))`).
 *
 * `fetchImpl` est injectable (tests / `fetch` lié au Worker), comme `sendWebPush`.
 */
export async function sendPushAndPrune(
  db: Db,
  subscription: WebPushSubscription,
  payload: Uint8Array | string,
  vapid: VapidKeys,
  options?: { fetchImpl?: typeof fetch; label?: string },
): Promise<SendResult | null> {
  const result = await sendWebPush(subscription, payload, vapid, {
    fetchImpl: options?.fetchImpl,
  }).catch((err) => {
    console.error(
      options?.label ?? "envoi push échoué",
      subscription.endpoint,
      err,
    );
    return null;
  });
  if (result?.gone) {
    await db
      .delete(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, subscription.endpoint));
  }
  return result;
}
