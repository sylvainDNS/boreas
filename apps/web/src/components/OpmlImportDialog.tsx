import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { importOpmlMutationOptions, type OpmlImportResult } from "../lib/opml";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";

/** Récap lisible d'un import réussi (#17). */
function summary(result: OpmlImportResult): string {
  const parts = [
    `${result.imported} ajouté${result.imported > 1 ? "s" : ""}`,
    `${result.reactivated} réactivé${result.reactivated > 1 ? "s" : ""}`,
    `${result.skipped} ignoré${result.skipped > 1 ? "s" : ""}`,
  ];
  return parts.join(" · ");
}

/**
 * Dialog d'import OPML (#17) : on choisit un fichier `.opml`, le SPA en lit le
 * texte et le poste à l'API. Le backfill des flux importés se fait en arrière-
 * plan (Queue) ; on affiche le récap (ajoutés / réactivés / ignorés) au succès.
 */
export function OpmlImportDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const mutation = useMutation(importOpmlMutationOptions(queryClient));

  function close() {
    setFile(null);
    mutation.reset();
    onClose();
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!file || mutation.isPending) return;
    mutation.mutate(file);
  }

  return (
    <Dialog open={open} onClose={close} title="Importer un OPML">
      {mutation.isSuccess ? (
        <div className="space-y-4">
          <p className="text-sm">
            Import terminé : {summary(mutation.data)}.
            {mutation.data.foldersCreated > 0 &&
              ` ${mutation.data.foldersCreated} dossier${
                mutation.data.foldersCreated > 1 ? "s" : ""
              } créé${mutation.data.foldersCreated > 1 ? "s" : ""}.`}
          </p>
          <p className="text-muted text-sm">
            Les articles des flux ajoutés arrivent progressivement en
            arrière-plan.
          </p>
          <div className="flex justify-end">
            <Button onClick={close}>Fermer</Button>
          </div>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div>
            <label
              htmlFor="opml-file"
              className="mb-1 block font-medium text-muted text-xs uppercase tracking-wide"
            >
              Fichier OPML
            </label>
            <input
              id="opml-file"
              name="file"
              type="file"
              accept=".opml,application/xml,text/xml"
              required
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="min-h-11 w-full rounded-card border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
            />
          </div>
          {mutation.isError && (
            <p className="text-red-600 text-sm dark:text-red-400" role="alert">
              Import impossible. Vérifiez que le fichier est un OPML valide.
            </p>
          )}
          <Button
            type="submit"
            className="w-full"
            disabled={!file || mutation.isPending}
          >
            {mutation.isPending ? "Import…" : "Importer"}
          </Button>
        </form>
      )}
    </Dialog>
  );
}
