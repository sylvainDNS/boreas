# Authentification par magic link

L'app est mono-utilisateur et exposée sur Internet. L'authentification se fait par **magic link** passwordless : un bouton « M'envoyer un lien » déclenche l'envoi (via **Cloudflare Email Service**) d'un lien contenant un token signé, court (~10 min) et à usage unique (hash stocké en D1) ; au clic, un **cookie de session signé** (stateless, ~60 j) est posé et validé à chaque requête. L'adresse cible est une **unique adresse configurée** (pas de champ email → pas d'énumération).

## Considered Options

- **Cloudflare Access (Zero Trust)** — le choix « évident » (zéro code d'auth). Rejeté : on préfère l'UX d'un lien plutôt qu'un IdP/OTP, sans dépendance à la config Access, et cela valorise le service Email déjà présent sur le compte.
- **Mot de passe + cookie / Basic Auth** — rejetés : mot de passe à gérer, UX inférieure.

## Consequences

- Du code d'auth à maintenir (génération/vérification de token, session signée) — assumé.
- Le service Email de Cloudflare n'envoie que vers des **adresses vérifiées** : suffisant en mono-user, mais ce design ne se généralise pas au multi-user.
