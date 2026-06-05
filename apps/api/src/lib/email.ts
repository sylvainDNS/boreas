import type { Env } from "../env";

type MailEnv = Pick<Env, "ENVIRONMENT" | "EMAIL_FROM" | "EMAIL">;

/**
 * Envoie le lien magic link à l'adresse autorisée via Cloudflare Email Service
 * (API structurée `EMAIL.send`, domaine expéditeur vérifié). Hors production
 * l'e-mail est mocké : le lien est seulement loggé (suivi en dev/test, aucun
 * envoi réel).
 */
export async function sendMagicLink(
  env: MailEnv,
  to: string,
  link: string,
): Promise<void> {
  if (env.ENVIRONMENT !== "production") {
    console.log(`[auth] magic link pour ${to} → ${link}`);
    return;
  }

  await env.EMAIL.send({
    from: { email: env.EMAIL_FROM, name: "Boréas" },
    to,
    subject: "Votre lien de connexion à Boréas",
    text: `Cliquez pour vous connecter (lien valable quelques minutes) :\n\n${link}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail.`,
  });
}
