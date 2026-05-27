# Schéma D1 dans le package partagé, migrations expand/contract

Les Workers API et Cron (ADR 0006) partagent la même base D1. Le **schéma et les migrations versionnées vivent dans le package partagé** du monorepo et sont appliqués via `wrangler d1 migrations apply` depuis une **configuration unique**, **indépendamment** des déploiements des Workers (une migration n'est liée au deploy d'aucun Worker en particulier). Les migrations suivent un schéma **expand-then-contract** : on ajoute (colonnes nullable, nouvelles tables) avant de retirer, jamais de renommage destructif en une étape.

## Considered Options

- **Un Worker « propriétaire » du schéma** (le Cron applique les migrations, l'API se contente de lire/écrire) — rejeté : couplage plus fort, et n'évite pas le besoin de rétro-compatibilité.

## Consequences

- Pendant un déploiement, les deux Workers peuvent tourner sur des versions de code différentes face au même schéma → la rétro-compatibilité expand/contract est **obligatoire**, pas optionnelle.
- Les types et requêtes D1 étant dans le package partagé (ADR 0006), schéma et accès restent colocalisés et cohérents entre les deux Workers.
