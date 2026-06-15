import { useEffect, useRef, useState } from "react";
import {
  getReadyRegistration,
  isPushSupported,
  PushPermissionError,
  subscribeToPush,
  unsubscribeFromPush,
} from "../lib/push";

/**
 * Interrupteur des **notifications push** (#79, ADR 0018). Sur le patron visuel de
 * `WifiOnlyToggle` (`role="switch"`, état via `aria-checked`), mais l'autorité
 * d'état est l'**abonnement réel** de l'appareil (`pushManager.getSubscription`),
 * pas un réglage : activer demande la permission + (dés)abonne, et le serveur
 * répond par une notification de test.
 *
 * Inerte si le Web Push n'est pas supporté (composant non rendu) ou si la
 * permission est **bloquée** (`denied`, irrévocable côté JS) : on désactive alors
 * le switch et on affiche un indice.
 */
export function PushToggle() {
  const [supported] = useState(() => isPushSupported());
  const [enabled, setEnabled] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);

  const blocked =
    supported &&
    typeof Notification !== "undefined" &&
    Notification.permission === "denied";

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    void getReadyRegistration()
      .then(async (registration) => {
        if (!registration) return;
        registrationRef.current = registration;
        const subscription = await registration.pushManager.getSubscription();
        if (!cancelled) setEnabled(subscription !== null);
      })
      .catch(() => {
        // SW indisponible (dev, ou `ready` jamais résolu) : on reste inerte.
      });
    return () => {
      cancelled = true;
    };
  }, [supported]);

  if (!supported) return null;

  async function onToggle() {
    const registration = registrationRef.current;
    if (!registration || pending || blocked) return;
    setPending(true);
    setError(null);
    try {
      if (enabled) {
        await unsubscribeFromPush(registration);
        setEnabled(false);
      } else {
        await subscribeToPush(registration);
        setEnabled(true);
      }
    } catch (err) {
      setError(
        err instanceof PushPermissionError
          ? "Autorisez les notifications dans votre navigateur pour les activer."
          : "Action impossible, réessayez.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label="Notifications push"
        disabled={pending || blocked}
        onClick={onToggle}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-border transition-colors focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 disabled:opacity-50 ${
          enabled ? "bg-accent" : "bg-surface-2"
        }`}
      >
        <span
          aria-hidden
          className={`inline-block size-4 rounded-full bg-surface shadow-card transition-transform ${
            enabled ? "translate-x-6" : "translate-x-1"
          }`}
        />
      </button>
      {(blocked || error) && (
        <p className="text-red-600 text-sm dark:text-red-400" role="alert">
          {blocked ? "Notifications bloquées dans le navigateur." : error}
        </p>
      )}
    </div>
  );
}
