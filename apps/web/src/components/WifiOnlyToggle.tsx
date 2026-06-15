import { useWifiOnly } from "../lib/wifi-only";

/**
 * Interrupteur du réglage **local** « Télécharger le contenu en Wi-Fi uniquement »
 * (#81, ADR 0018). Préférence **par appareil** (localStorage, jamais serveur, cf.
 * `lib/wifi-only.ts`) : `useWifiOnly` est l'autorité. Bouton `role="switch"`
 * (accessible, état via `aria-checked`), sur le patron visuel de `ThemeToggle`.
 */
export function WifiOnlyToggle() {
  const { wifiOnly, setWifiOnly } = useWifiOnly();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={wifiOnly}
      aria-label="Télécharger le contenu en Wi-Fi uniquement"
      onClick={() => setWifiOnly(!wifiOnly)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-border transition-colors focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 ${
        wifiOnly ? "bg-accent" : "bg-surface-2"
      }`}
    >
      <span
        aria-hidden
        className={`inline-block size-4 rounded-full bg-surface shadow-card transition-transform ${
          wifiOnly ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
  );
}
