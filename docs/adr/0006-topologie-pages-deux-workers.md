# Topologie : Pages + deux Workers

Le déploiement sépare trois unités : **Pages** sert le SPA statique (React + Vite), un **Worker API** sert l'API JSON (auth magic link, lecture, extraction du contenu à l'ouverture) et un **Worker Cron** assure l'ingestion planifiée et la maintenance (fetch des flux, déduplication, upsert, purge). Tous deux partagent les bindings D1 et R2. Le code commun (schéma + accès D1, types, parser de flux, logique de dédup) vit dans un **package partagé** d'un monorepo, consommé par les deux Workers — jamais dupliqué.

## Considered Options

- **Worker unique exposant `fetch` + `scheduled`** — le pattern Cloudflare le plus courant (une seule unité fait API et cron). Rejeté au profit de la séparation.
- **Pages + Worker unique (API + cron)** — intermédiaire, rejeté pour la même raison.

## Consequences

- **Isolation** voulue : un déploiement de l'API n'interrompt pas l'ingestion ; observabilité distincte ; le Cron write-heavy est séparé de l'API read-heavy.
- **Coût** : trois déploiements à coordonner et un package partagé à maintenir (sans quoi le code divergerait entre Workers).
- Cohérent avec l'ADR 0002 : le module de fetch isolé est précisément ce package partagé.
