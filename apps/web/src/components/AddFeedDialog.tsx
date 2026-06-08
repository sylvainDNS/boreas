import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { ApiError } from "../lib/api";
import {
  type DiscoveredFeed,
  subscribeFeedMutationOptions,
} from "../lib/feeds";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";

// Messages d'erreur par code applicatif renvoyé par l'API (#12). Défaut : échec
// réseau / URL invalide.
const ERROR_MESSAGES: Record<string, string> = {
  already_subscribed: "Vous êtes déjà abonné à ce flux.",
  invalid_feed: "Ce flux semble illisible.",
  no_feed_found: "Aucun flux trouvé sur cette page.",
};

function errorMessage(error: unknown): string {
  const mapped =
    error instanceof ApiError && error.code
      ? ERROR_MESSAGES[error.code]
      : undefined;
  return (
    mapped ??
    "Impossible de récupérer cette URL. Vérifiez l'adresse et réessayez."
  );
}

/**
 * Dialog d'ajout de flux (#12). On colle une URL de flux **ou de site** ; le
 * backend abonne directement ou, si le site expose plusieurs flux, renvoie des
 * candidats qu'on présente dans un sélecteur. Choisir un candidat relance la
 * même mutation avec son URL.
 */
export function AddFeedDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");
  const [candidates, setCandidates] = useState<DiscoveredFeed[] | null>(null);
  const mutation = useMutation(subscribeFeedMutationOptions(queryClient));

  function close() {
    setUrl("");
    setCandidates(null);
    mutation.reset();
    onClose();
  }

  function submit(target: string) {
    const trimmed = target.trim();
    if (!trimmed || mutation.isPending) return;
    mutation.mutate(trimmed, {
      onSuccess: (outcome) => {
        if (outcome.kind === "subscribed") {
          close();
        } else {
          // Plusieurs flux : on bascule sur le sélecteur.
          setCandidates(outcome.candidates);
        }
      },
    });
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    submit(url);
  }

  return (
    <Dialog open={open} onClose={close} title="Ajouter un flux">
      {candidates ? (
        <div>
          <p className="mb-3 text-muted text-sm">
            Plusieurs flux sont disponibles sur cette page. Choisissez celui à
            suivre :
          </p>
          <ul className="space-y-2">
            {candidates.map((candidate) => (
              <li key={candidate.url}>
                <button
                  type="button"
                  onClick={() => submit(candidate.url)}
                  disabled={mutation.isPending}
                  className="flex w-full flex-col items-start gap-0.5 rounded-card border border-border bg-surface px-3 py-2 text-left transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 disabled:opacity-50"
                >
                  <span className="font-medium text-sm">
                    {candidate.title ?? candidate.url}
                  </span>
                  <span className="flex items-center gap-2 text-muted text-xs">
                    <span className="uppercase">{candidate.type}</span>
                    <span className="truncate">{candidate.url}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {mutation.isError && (
            <p
              className="mt-3 text-red-600 text-sm dark:text-red-400"
              role="alert"
            >
              {errorMessage(mutation.error)}
            </p>
          )}
          <button
            type="button"
            onClick={() => {
              setCandidates(null);
              mutation.reset();
            }}
            className="mt-4 text-muted text-sm underline-offset-2 hover:underline"
          >
            ← Saisir une autre URL
          </button>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div>
            <label
              htmlFor="feed-url"
              className="mb-1 block font-medium text-muted text-xs uppercase tracking-wide"
            >
              URL du flux ou du site
            </label>
            <input
              id="feed-url"
              name="url"
              type="url"
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://exemple.com"
              className="min-h-11 w-full rounded-card border border-border bg-bg px-3 text-sm outline-none focus:border-accent focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
            />
          </div>
          {mutation.isError && (
            <p className="text-red-600 text-sm dark:text-red-400" role="alert">
              {errorMessage(mutation.error)}
            </p>
          )}
          <Button
            type="submit"
            className="w-full"
            disabled={mutation.isPending}
          >
            {mutation.isPending ? "Recherche…" : "Ajouter"}
          </Button>
        </form>
      )}
    </Dialog>
  );
}
