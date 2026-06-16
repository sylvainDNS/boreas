/**
 * Notification push « article prêt à lire » (#80, ADR 0018). Émise par le
 * consommateur de Queue après une ingestion ayant inséré des articles net-new :
 * **un push par Feed** concerné, à **tous** les appareils abonnés (app
 * mono-utilisateur, abonnement = endpoint, pas de `user_id`).
 *
 * Le payload (`PushNotificationPayload`, contrat partagé avec le SW) porte tout
 * le contenu visible : le handler `push` du SW pull/télécharge d'abord, puis
 * l'affiche tel quel via `buildNotification`. Émission **best-effort** : un envoi
 * raté n'échoue jamais l'ingestion (cf. `processIngestionBatch`) ; un endpoint
 * périmé (404/410) est purgé, comme à l'abonnement (`apps/api/src/routes/push.ts`).
 */

import type { PushNotificationPayload } from "@boreas/api-contracts";
import type { IngestResult } from "@boreas/shared";
import { type Db, pushSubscriptions } from "@boreas/shared";
import { sendWebPush, type VapidKeys } from "@boreas/shared/crypto";
import { eq } from "drizzle-orm";

/**
 * Compose le payload de notification d'un Feed à partir de son issue d'ingestion
 * (#80) : **titre = nom du Feed**, **corps = titre du premier article net-new**
 * (+ « +N autre(s) » si plusieurs), **tag = feedId** (coalescence → une seule
 * notif par Feed), **tap → `/feeds/:feedId`**. Replis défensifs si le flux ou
 * l'article n'a pas de titre — un push doit toujours produire une notif lisible.
 */
export function buildArticleNotificationPayload(
  result: IngestResult,
): PushNotificationPayload {
  const title = result.title?.trim() || "Boréas";
  const first = result.newArticleTitles[0]?.trim() || "Nouvel article";
  const others = result.inserted - 1;
  const body =
    others > 0 ? `${first} +${others} autre${others > 1 ? "s" : ""}` : first;
  return {
    title,
    body,
    tag: result.feedId,
    url: `/feeds/${result.feedId}`,
  };
}

/**
 * Émet le push d'un Feed à tous les abonnés (#80). Sérialise le payload composé,
 * l'envoie à chaque `push_subscriptions` et **purge** les endpoints périmés
 * (404/410 → `gone`). Chaque envoi est isolé : une erreur réseau/chiffrement est
 * loguée mais n'interrompt pas les autres abonnés. No-op s'il n'y a aucun abonné.
 *
 * `fetchImpl` est injectable (tests / `fetch` lié au Worker), comme `sendWebPush`.
 */
export async function notifyNewArticles(
  result: IngestResult,
  db: Db,
  vapid: VapidKeys,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const subscriptions = await db
    .select({
      endpoint: pushSubscriptions.endpoint,
      p256dh: pushSubscriptions.p256dh,
      auth: pushSubscriptions.auth,
    })
    .from(pushSubscriptions);
  if (subscriptions.length === 0) return;

  const payload = JSON.stringify(buildArticleNotificationPayload(result));

  // Envois indépendants → en parallèle (borne la latence à ~1 round-trip plutôt
  // que la somme), chacun isolé : une erreur n'interrompt pas les autres abonnés.
  await Promise.all(
    subscriptions.map(async (sub) => {
      const sent = await sendWebPush(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        payload,
        vapid,
        { fetchImpl },
      ).catch((err) => {
        console.error("[cron:queue] envoi push échoué", sub.endpoint, err);
        return null;
      });
      if (sent?.gone) {
        await db
          .delete(pushSubscriptions)
          .where(eq(pushSubscriptions.endpoint, sub.endpoint));
      }
    }),
  );
}
