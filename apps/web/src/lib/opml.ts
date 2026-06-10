import type { OpmlImportResponse } from "@boreas/api-contracts";
import type { QueryClient } from "@tanstack/react-query";
import { apiFetch } from "./api";
import { invalidateAfterFeedLifecycle } from "./feeds";
import { FOLDERS_LIST_KEY } from "./folders";

/** Nom de fichier de repli si la réponse ne porte pas de `Content-Disposition`. */
const EXPORT_FALLBACK_FILENAME = "boreas-feeds.opml";

/** Extrait le `filename="…"` d'un en-tête `Content-Disposition`, sinon le repli. */
function filenameFromDisposition(header: string | null): string {
  const match = header?.match(/filename="?([^"]+)"?/i);
  return match?.[1] ?? EXPORT_FALLBACK_FILENAME;
}

/**
 * Télécharge l'export OPML (#17). On passe par `fetch` + `Blob` plutôt qu'un
 * `<a href download>` direct : une ancre enregistrerait n'importe quelle réponse,
 * y compris le JSON d'une 401 (session expirée), sous un nom `.opml` — produisant
 * un fichier corrompu et silencieux. Ici on vérifie le statut et on lève en cas
 * d'échec pour que l'appelant affiche une erreur. Le nom de fichier (daté) vient
 * du `Content-Disposition` serveur.
 */
export async function downloadOpmlExport(): Promise<void> {
  const res = await fetch("/api/opml/export", { credentials: "include" });
  if (!res.ok) {
    throw new Error(`export_failed_${res.status}`);
  }

  const blob = await res.blob();
  const filename = filenameFromDisposition(
    res.headers.get("content-disposition"),
  );
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Récapitulatif d'un import OPML, renvoyé par `POST /api/opml/import` (#17). */
export type OpmlImportResult = OpmlImportResponse;

/**
 * Mutation d'import OPML (#17). Lit le fichier choisi côté client (`file.text()`)
 * et l'envoie en JSON à `POST /api/opml/import`. En cas de succès, invalide
 * feeds, folders, listes et compteurs d'articles : les flux et dossiers importés
 * apparaissent dans la sidebar (le backfill arrive ensuite via la Queue +
 * polling existant).
 */
export function importOpmlMutationOptions(queryClient: QueryClient) {
  return {
    mutationFn: async (file: File): Promise<OpmlImportResult> => {
      const opml = await file.text();
      return apiFetch<OpmlImportResponse>("/opml/import", {
        method: "POST",
        body: JSON.stringify({ opml }),
      });
    },
    onSuccess: () => {
      // Réutilise le cycle de vie feed (feeds + listes/compteurs d'articles) et
      // ajoute les Folders, que l'import est seul à créer.
      invalidateAfterFeedLifecycle(queryClient);
      void queryClient.invalidateQueries({ queryKey: FOLDERS_LIST_KEY });
    },
  };
}
