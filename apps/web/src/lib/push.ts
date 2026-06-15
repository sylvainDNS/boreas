/**
 * Plomberie Web Push côté client (#79, ADR 0018).
 *
 * Découpée pour rester testable hors d'un vrai service worker : `buildNotification`
 * est pure (utilisée par le handler `push` du SW), et le flux d'(dés)abonnement
 * prend la `ServiceWorkerRegistration` en paramètre.
 */

import type { PushNotificationPayload } from "@boreas/api-contracts";
import { apiFetch } from "./api";

/** Levée quand l'utilisateur refuse (ou ignore) la permission de notification. */
export class PushPermissionError extends Error {
  constructor(public readonly permission: NotificationPermission) {
    super(`Permission de notification non accordée (${permission})`);
    this.name = "PushPermissionError";
  }
}

/** Vrai si le navigateur supporte le Web Push (SW + PushManager + Notification). */
export function isPushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/**
 * `ServiceWorkerRegistration` prête (le SW contrôle la page), ou `null` si le
 * Web Push n'est pas supporté. Le SW n'étant enregistré qu'en PROD
 * (`register-sw.tsx`), `ready` ne se résout pas en dev — le toggle reste inerte.
 */
export async function getReadyRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!isPushSupported()) return null;
  return navigator.serviceWorker.ready;
}

/**
 * Décode une clé VAPID base64url (sans padding) en `Uint8Array`, format attendu
 * par `pushManager.subscribe({ applicationServerKey })`.
 */
export function urlBase64ToUint8Array(
  base64url: string,
): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/**
 * Demande la permission Notification, abonne l'appareil au Web Push avec la clé
 * publique VAPID (`VITE_VAPID_PUBLIC_KEY`), puis enregistre l'abonnement côté
 * serveur (`POST /api/push/subscribe`), qui répond en envoyant une notification
 * de test. Lève `PushPermissionError` si la permission n'est pas accordée — on
 * n'appelle alors ni `subscribe` ni l'API.
 */
export async function subscribeToPush(
  registration: ServiceWorkerRegistration,
): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new PushPermissionError(permission);
  }
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(
      import.meta.env.VITE_VAPID_PUBLIC_KEY,
    ),
  });
  try {
    await apiFetch("/push/subscribe", {
      method: "POST",
      body: JSON.stringify(subscription.toJSON()),
    });
  } catch (err) {
    // L'enregistrement serveur a échoué : on annule l'abonnement navigateur pour
    // ne pas laisser un abonnement « fantôme » (navigateur abonné mais serveur
    // ignorant → toggle ON au prochain montage alors qu'aucun push ne partira).
    await subscription.unsubscribe().catch(() => undefined);
    throw err;
  }
}

/**
 * Désabonne l'appareil : supprime l'abonnement côté serveur
 * (`DELETE /api/push/subscribe`) puis localement. No-op s'il n'y a pas
 * d'abonnement courant (déjà désabonné).
 */
export async function unsubscribeFromPush(
  registration: ServiceWorkerRegistration,
): Promise<void> {
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  await apiFetch("/push/subscribe", {
    method: "DELETE",
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  });
  await subscription.unsubscribe();
}

/** Payload poussé par le serveur (route `push.ts`) et lu par le handler `push`. */
export type PushPayload = PushNotificationPayload;

/** Arguments de `registration.showNotification(title, options)`. */
export interface BuiltNotification {
  title: string;
  options: NotificationOptions;
}

/**
 * Traduit un payload push en arguments de `showNotification`. **Défensif** :
 * un payload partiel/illisible retombe sur des valeurs de repli (titre = appli,
 * URL = racine), pour qu'une notification s'affiche toujours plutôt que de planter
 * le handler `push` (Chrome sanctionne un push sans notification visible).
 */
export function buildNotification(
  payload: Partial<PushPayload> | null | undefined,
): BuiltNotification {
  const title = payload?.title?.trim() || "Boréas";
  const options: NotificationOptions = {
    body: payload?.body,
    tag: payload?.tag,
    data: { url: payload?.url ?? "/" },
  };
  return { title, options };
}
