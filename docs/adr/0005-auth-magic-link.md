# Authentification par magic link

L'app est mono-utilisateur et exposée sur Internet. L'authentification se fait par **magic link** passwordless : un bouton « M'envoyer un lien » déclenche l'envoi (via **Cloudflare Email Service**) d'un lien contenant un token signé, court (~10 min) et à usage unique (hash stocké en D1) ; au clic, un **cookie de session signé** (stateless, ~60 j) est posé et validé à chaque requête. L'adresse autorisée est une **unique adresse configurée** côté serveur ; la page de connexion expose un champ e-mail (design #4) mais `POST /auth/request` répond de façon **générique quelle que soit l'adresse saisie** (pas d'énumération) et n'émet un lien que pour l'adresse autorisée.

## Considered Options

- **Cloudflare Access (Zero Trust)** — le choix « évident » (zéro code d'auth). Rejeté : on préfère l'UX d'un lien plutôt qu'un IdP/OTP, sans dépendance à la config Access, et cela valorise le service Email déjà présent sur le compte.
- **Mot de passe + cookie / Basic Auth** — rejetés : mot de passe à gérer, UX inférieure.

## Consequences

- Du code d'auth à maintenir (génération/vérification de token, session signée) — assumé.
- L'envoi passe par **Cloudflare Email Service** (« Email Sending ») : c'est le **domaine expéditeur** (`boreas.sylvaindenyse.me`) qui est vérifié, pas le destinataire. La limite mono-utilisateur est donc **applicative** (on n'émet un lien que pour l'`allowed_email`), pas une contrainte de la plateforme — le design se généraliserait au multi-user.
