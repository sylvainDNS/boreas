import { useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { OpmlImportDialog } from "../components/OpmlImportDialog";
import { ThemeToggle } from "../components/ThemeToggle";
import { Button } from "../components/ui/Button";
import { downloadOpmlExport } from "../lib/opml";

/** Réglages (PRD US #49, #50). Câblage à l'API laissé à la tranche #18 ; ici, gabarit. */
export const Route = createFileRoute("/_shell/settings")({
  component: SettingsView,
});

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

function SettingsView() {
  const [importOpen, setImportOpen] = useState(false);
  const exportMutation = useMutation({ mutationFn: downloadOpmlExport });

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
            <span className="rounded-card bg-surface-2 px-3 py-2 text-muted text-sm">
              30 min
            </span>
          </Row>
          <Row
            label="Fenêtre de purge"
            hint="Les articles lus et non sauvegardés sont supprimés après ce délai."
          >
            <span className="rounded-card bg-surface-2 px-3 py-2 text-muted text-sm">
              60 jours
            </span>
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
        <p className="mt-4 text-muted text-sm">
          Les réglages persistants seront connectés à l'API dans une tranche
          ultérieure (#18).
        </p>
      </div>
      <OpmlImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
      />
    </div>
  );
}
