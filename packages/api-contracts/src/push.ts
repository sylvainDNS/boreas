import { z } from "zod";

/**
 * Abonnement Web Push (#79) — forme de `PushSubscription.toJSON()` du navigateur :
 * un `endpoint` (service push) + les clés publiques du client (`p256dh`/`auth`)
 * utilisées pour chiffrer le payload (aes128gcm, RFC 8291). `expirationTime` du
 * navigateur (souvent `null`) est ignoré (zod retire les champs inconnus).
 */
export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionSchema>;

/** Désabonnement (#79) : l'`endpoint` identifie la ligne à supprimer. */
export const pushUnsubscribeSchema = z.object({
  endpoint: z.string().url(),
});
export type PushUnsubscribeInput = z.infer<typeof pushUnsubscribeSchema>;

/**
 * Payload d'une notification push (#79) — **contrat partagé** entre l'émetteur
 * (route `/api/push`, et le consommateur de Queue de #80) et le lecteur côté SW
 * (`buildNotification`). Centralisé ici pour éviter que les deux bouts dérivent
 * (champ renommé d'un côté, ignoré de l'autre). Sérialisé en JSON dans le push.
 */
export interface PushNotificationPayload {
  title: string;
  body?: string;
  tag?: string;
  /** Cible du tap (lue par `notificationclick`). Défaut côté SW : racine. */
  url?: string;
}
