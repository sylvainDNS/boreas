import { Button } from "./ui/Button";

interface UpdateBannerProps {
  /** Une nouvelle version du service worker est en attente d'activation. */
  needRefresh: boolean;
  /** Active le SW en attente puis recharge (`updateServiceWorker(true)`). */
  onUpdate: () => void;
}

/**
 * Bandeau de mise à jour (#76, ADR 0018). Affiché quand un nouveau service
 * worker est **en attente** (precaché mais pas encore actif) : un clic active la
 * nouvelle version et recharge. Composant **piloté par props** — la connexion à
 * `virtual:pwa-register/react` vit dans `register-sw.tsx`, ce qui le rend
 * testable sans vrai SW.
 */
export function UpdateBanner({ needRefresh, onUpdate }: UpdateBannerProps) {
  if (!needRefresh) return null;

  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-0 z-50 flex items-center justify-center gap-3 border-border border-t bg-surface px-4 py-3 shadow-pop"
    >
      <span className="text-sm text-text">
        Une nouvelle version de Boréas est disponible.
      </span>
      <Button variant="primary" onClick={onUpdate}>
        Mettre à jour
      </Button>
    </div>
  );
}
