import { createFileRoute } from "@tanstack/react-router";
import { BrandLogo } from "../components/ui/BrandLogo";
import { Button } from "../components/ui/Button";

/** Page de connexion magic-link. Design seul (#4) — la logique request/verify
 *  est branchée en tranche #5. Volontairement hors du shell applicatif. */
export const Route = createFileRoute("/login")({
  component: LoginView,
});

function LoginView() {
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

        <form
          className="space-y-4"
          // Logique d'envoi câblée en #5 ; le formulaire est inerte ici.
          onSubmit={(e) => e.preventDefault()}
        >
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
              placeholder="vous@exemple.com"
              className="min-h-11 w-full rounded-card border border-border bg-bg px-3 text-sm outline-none focus:border-accent focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
            />
          </div>
          <Button type="submit" className="w-full">
            M'envoyer un lien
          </Button>
        </form>

        <p className="mt-4 text-center text-muted text-xs">
          Aucun mot de passe. Le lien expire en quelques minutes.
        </p>
      </div>
    </div>
  );
}
