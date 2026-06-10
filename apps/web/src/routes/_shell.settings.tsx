import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { OpmlImportDialog } from "../components/OpmlImportDialog";
import { ThemeToggle } from "../components/ThemeToggle";
import { Button } from "../components/ui/Button";
import { Select } from "../components/ui/Select";
import { downloadOpmlExport } from "../lib/opml";
import {
  settingsQueryOptions,
  updateSettingsMutationOptions,
} from "../lib/settings";

/** Réglages (PRD US #49, #50) câblés à `GET/PATCH /api/settings` (#18). */
export const Route = createFileRoute("/_shell/settings")({
  component: SettingsView,
});

/** Presets d'intervalle de rafraîchissement (minutes). */
const REFRESH_PRESETS = [15, 30, 60, 120];
/** Presets de fenêtre de purge (jours). */
const PURGE_PRESETS = [30, 60, 90, 180];

/**
 * Garantit que la valeur courante figure dans la liste, même hors presets (un
 * PATCH antérieur a pu poser une valeur sur mesure) : on l'ajoute et on trie.
 */
function withCurrent(presets: number[], current: number): number[] {
  return presets.includes(current)
    ? presets
    : [...presets, current].sort((a, b) => a - b);
}

/**
 * Menu de presets numériques piloté par l'API. `value` à `undefined` = en cours
 * de chargement (placeholder, désactivé). Ignore une sélection vide par sécurité
 * (garde la borne serveur `min(1)` même si `disabled` venait à sauter).
 */
function PresetSelect({
  label,
  value,
  presets,
  unit,
  disabled,
  onSelect,
}: {
  label: string;
  value: number | undefined;
  presets: number[];
  unit: string;
  disabled: boolean;
  onSelect: (value: number) => void;
}) {
  return (
    <Select
      aria-label={label}
      disabled={disabled}
      value={value ?? ""}
      onChange={(e) => {
        const next = Number(e.target.value);
        if (Number.isFinite(next) && next > 0) onSelect(next);
      }}
    >
      {value === undefined ? (
        <option value="">…</option>
      ) : (
        withCurrent(presets, value).map((v) => (
          <option key={v} value={v}>
            {v} {unit}
          </option>
        ))
      )}
    </Select>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-4 border-border border-b py-4 last:border-0">
      <div className="min-w-0 flex-1">
        <div className="font-medium">{label}</div>
        {hint && <div className="text-muted text-sm">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

// Exporté pour les tests (le composant de route n'est pas accessible via `Route`).
export function SettingsView() {
  const [importOpen, setImportOpen] = useState(false);
  const exportMutation = useMutation({ mutationFn: downloadOpmlExport });

  const queryClient = useQueryClient();
  const settings = useQuery(settingsQueryOptions());
  const update = useMutation(updateSettingsMutationOptions(queryClient));
  // La réconciliation thème serveur→local vit dans le shell (`useServerThemeSync`)
  // pour s'appliquer à toute l'app, pas seulement ici.

  const data = settings.data;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-8 sm:px-8">
        <h1 className="mb-6 font-semibold text-2xl">Réglages</h1>
        <div className="rounded-card border border-border bg-surface p-2 px-5 shadow-card">
          <Row
            label="Thème"
            hint="Apparence claire, sombre ou selon le système."
          >
            <div className="w-48">
              <ThemeToggle />
            </div>
          </Row>
          <Row
            label="Intervalle de rafraîchissement"
            hint="Fréquence de récupération des flux en arrière-plan."
          >
            <PresetSelect
              label="Intervalle de rafraîchissement"
              value={data?.refreshIntervalMin}
              presets={REFRESH_PRESETS}
              unit="min"
              disabled={!data || update.isPending}
              onSelect={(refreshIntervalMin) =>
                update.mutate({ refreshIntervalMin })
              }
            />
          </Row>
          <Row
            label="Fenêtre de purge"
            hint="Les articles lus et non sauvegardés sont supprimés après ce délai."
          >
            <PresetSelect
              label="Fenêtre de purge"
              value={data?.purgeWindowDays}
              presets={PURGE_PRESETS}
              unit="jours"
              disabled={!data || update.isPending}
              onSelect={(purgeWindowDays) => update.mutate({ purgeWindowDays })}
            />
          </Row>
          <Row
            label="Import / Export OPML"
            hint="Migrez vos abonnements depuis ou vers un autre lecteur."
          >
            <div className="flex flex-col items-end gap-1">
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={exportMutation.isPending}
                  onClick={() => exportMutation.mutate()}
                >
                  {exportMutation.isPending ? "Export…" : "Exporter"}
                </Button>
                <Button variant="primary" onClick={() => setImportOpen(true)}>
                  Importer
                </Button>
              </div>
              {exportMutation.isError && (
                <p
                  className="text-red-600 text-sm dark:text-red-400"
                  role="alert"
                >
                  Export impossible, réessayez.
                </p>
              )}
            </div>
          </Row>
        </div>
        {settings.isError && (
          <p
            className="mt-4 text-red-600 text-sm dark:text-red-400"
            role="alert"
          >
            Chargement des réglages impossible, réessayez.
          </p>
        )}
        {update.isError && (
          <p
            className="mt-4 text-red-600 text-sm dark:text-red-400"
            role="alert"
          >
            Enregistrement impossible, réessayez.
          </p>
        )}
      </div>
      <OpmlImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
      />
    </div>
  );
}
