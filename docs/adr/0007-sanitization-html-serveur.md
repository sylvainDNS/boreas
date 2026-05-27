# Sanitization du HTML côté serveur

Le contenu des flux et le contenu extrait sont du HTML arbitraire non fiable ; l'injecter tel quel dans le SPA ouvrirait une faille XSS stockée (vol du cookie de session). Tout HTML — **résumé fourni par le flux** (à l'ingestion, Worker Cron) comme **contenu extrait** (à l'ouverture, Worker API) — est donc **sanitizé côté serveur avec DOMPurify (sur un DOM `linkedom`) avant tout stockage/cache**. Le store ne contient que du HTML sûr par construction. Une **CSP stricte** sur le SPA sert de défense en profondeur.

## Considered Options

- **Sanitization client au rendu (DOMPurify navigateur)** — rejeté : risque qu'un chemin de rendu oublie de nettoyer ; le store reste piégé.
- **Serveur + client** — défense en profondeur maximale mais double traitement jugé superflu vu la CSP.

## Consequences

- `linkedom` est mutualisé entre l'extraction Readability (ADR 0003) et la sanitization.
- Le HTML stocké est sûr → le rendu côté SPA est trivial (pas de dépendance de sécurité au client).
- Si les règles de sanitization évoluent, le contenu déjà stocké doit être re-sanitizé (on ne conserve pas l'original brut).
