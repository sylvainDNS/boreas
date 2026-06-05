/** Bindings et variables injectés par le runtime Cloudflare dans le Worker API. */
export interface Env {
  /** Base D1 partagée avec le Cron. */
  DB: D1Database;
  /** Envoi du magic link (Cloudflare Email Service). */
  EMAIL: SendEmail;
  /** Clé HMAC partagée (api + cron) pour signer jetons et sessions. Secret Worker. */
  HMAC_SECRET: string;
  /** Adresse expéditrice du magic link (domaine vérifié dans Cloudflare Email Sending). */
  EMAIL_FROM: string;
  /** Origine publique de l'app — base des liens envoyés par e-mail. */
  APP_BASE_URL: string;
  /** "production" en prod ; toute autre valeur mocke l'envoi d'e-mail. */
  ENVIRONMENT: string;
}
