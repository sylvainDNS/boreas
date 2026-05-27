# API servie sur la même origine que le SPA

Le SPA (Pages) et le Worker API doivent partager l'origine pour que le cookie de session (ADR 0005) circule simplement et sans surface CSRF/CORS. L'API est donc exposée sous **`/api/*` sur l'hôte du SPA**, le Worker API restant une unité séparée, invoquée soit par une **route Worker** sur ce chemin, soit par un **proxy Pages Function** utilisant un *service binding* (`env.API.fetch(request)`, sans hop réseau). Le cookie de session est `HttpOnly; Secure; SameSite=Strict`.

## Considered Options

- **Sous-domaine dédié `api.example.com` + CORS** — rejeté : impose CORS avec credentials, un scope de cookie au domaine parent, `SameSite=Lax` et un token CSRF explicite. Plus de surface à configurer et sécuriser.

## Consequences

- Aucune configuration CORS ; `SameSite=Strict` neutralise le CSRF par construction.
- Le SPA Pages n'est plus 100 % statique si l'on retient le proxy Pages Function (une Function minimale) ; l'alternative route Worker garde Pages statique.
- Cohérent avec la topologie en Workers séparés (ADR 0006) : le Worker API reste isolé, simplement atteint via binding/route.
