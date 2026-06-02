import type { ThemePreference } from "../lib/theme";
import { useTheme } from "../lib/use-theme";

const OPTIONS: { value: ThemePreference; label: string; icon: string }[] = [
  { value: "light", label: "Clair", icon: "☀" },
  { value: "dark", label: "Sombre", icon: "☾" },
  { value: "system", label: "Système", icon: "⌥" },
];

/** Contrôle segmenté de la préférence de thème (clair / sombre / système). */
export function ThemeToggle() {
  const { preference, setPreference } = useTheme();
  return (
    <fieldset className="flex min-w-0 gap-0.5 rounded-card border border-border bg-bg p-0.5">
      <legend className="sr-only">Thème</legend>
      {OPTIONS.map((opt) => {
        const active = preference === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            title={opt.label}
            onClick={() => setPreference(opt.value)}
            className={`flex flex-1 items-center justify-center rounded-[calc(var(--radius-card)-3px)] py-1.5 text-sm transition-colors ${
              active
                ? "bg-surface text-accent shadow-card"
                : "text-muted hover:text-text"
            }`}
          >
            <span aria-hidden>{opt.icon}</span>
            <span className="sr-only">{opt.label}</span>
          </button>
        );
      })}
    </fieldset>
  );
}
