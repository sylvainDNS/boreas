import { useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { BrandLogo } from "../components/ui/BrandLogo";
import { Button } from "../components/ui/Button";
import { requestMagicLink } from "../lib/auth";

/** Page de connexion magic-link : demande un lien à usage unique (#5). */
export const Route = createFileRoute("/login")({
  component: LoginView,
});

function LoginView() {
  const [email, setEmail] = useState("");
  const mutation = useMutation({
    mutationFn: (address: string) => requestMagicLink(address),
  });

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // Évite une double émission (Entrée répétée avant le re-render isPending).
    if (mutation.isPending) return;
    const address = email.trim();
    if (address) mutation.mutate(address);
  }

  return (
    <div className="grid min-h-screen place-items-center bg-bg p-6 text-text">
      <div className="w-full max-w-sm rounded-card border border-border bg-surface p-8 shadow-card">
        <div className="mb-6">
          <BrandLogo markClassName="size-9" />
        </div>

        <h1 className="mb-1 font-semibold text-2xl">Connexion</h1>
        <p className="mb-6 text-muted text-sm">
          Recevez un lien de connexion à usage unique sur votre adresse.
        </p>

        {mutation.isSuccess ? (
          <p
            className="rounded-card border border-border bg-bg p-4 text-sm"
            role="status"
          >
            Si l'adresse est reconnue, un lien de connexion vient d'être envoyé.
            Pensez à vérifier vos spams.
          </p>
        ) : (
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div>
              <label
                htmlFor="email"
                className="mb-1 block font-medium text-muted text-xs uppercase tracking-wide"
              >
                Adresse e-mail
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="vous@exemple.com"
                className="min-h-11 w-full rounded-card border border-border bg-bg px-3 text-sm outline-none focus:border-accent focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
              />
            </div>
            {mutation.isError && (
              <p
                className="text-red-600 text-sm dark:text-red-400"
                role="alert"
              >
                Échec de l'envoi. Vérifiez l'adresse et réessayez.
              </p>
            )}
            <Button
              type="submit"
              className="w-full"
              disabled={mutation.isPending}
            >
              {mutation.isPending ? "Envoi…" : "M'envoyer un lien"}
            </Button>
          </form>
        )}

        <p className="mt-4 text-center text-muted text-xs">
          Aucun mot de passe. Le lien expire en quelques minutes.
        </p>
      </div>
    </div>
  );
}
