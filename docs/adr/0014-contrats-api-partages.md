# Contrats HTTP partagés entre Worker API et SPA

Les DTOs de l'API HTTP étaient définis **deux fois** : une fois côté Worker (schémas Zod de requête + formes de réponse construites à la main dans les routes) et une fois côté SPA (interfaces TypeScript miroir dans `apps/web/src/lib/*.ts`). Rien ne reliait les deux : une réponse pouvait diverger silencieusement de la forme attendue par le client, et l'enum `theme` était redéclaré à trois endroits. Aucun test de contrat ne couvrait cette frontière.

La décision (#45, epic #40) crée le package **`@boreas/api-contracts`** comme **source de vérité unique des contrats wire** :

- **Schémas Zod épinglés sur `zod@4.4.3`** (même version qu'api et web), un module par ressource (`auth`, `settings`, `folders`, `feeds`, `articles`, `opml`, `refresh`, plus `common`). Les types sont **inférés** des schémas (`z.infer`), jamais redéclarés.
- **Interdiction structurelle d'importer `@boreas/shared`** : le package ne dépend que de `zod`. Importer `@boreas/shared` y tirerait drizzle/linkedom et leurs types Cloudflare/node, ce qui contaminerait le SPA. Le `tsconfig` n'inclut donc **aucun type** ambiant (`"types": []`).
- **Côté API** : les corps de requête sont validés par les schémas du package ; les réponses sont liées par **`satisfies XxxResponse` au point de construction**, de sorte qu'une dérive de forme casse au `typecheck` plutôt qu'en production.
- **Côté SPA** : `import type` **uniquement** — aucune validation runtime des réponses en prod (on fait confiance au contrat partagé + au `satisfies` serveur). Les **modèles de vue** restent locaux : `Article` (enrichi : libellé relatif, `unread`), `SubscribeOutcome` (discriminé sur `kind`), `UpdateFeedInput`. `theme.ts` ré-exporte `type ThemePreference = Theme`.

## Considered Options

- **Garder deux définitions miroir** — rejeté : statu quo, dérive silencieuse possible et enum triplé ; le coût de la divergence augmente à chaque ressource ajoutée.
- **Partager les types depuis `@boreas/shared`** — rejeté : `shared` tire drizzle/linkedom et les types Cloudflare/node ; les importer dans le SPA polluerait son contexte de types et son bundle. Les contrats wire sont une préoccupation distincte du schéma D1.
- **OpenAPI / tRPC** — rejeté pour un mono-utilisateur : surcouche de génération ou de runtime disproportionnée ; Zod (déjà utilisé) + `satisfies` couvre la dérive au typecheck sans dépendance supplémentaire.
- **Validation runtime des réponses côté SPA** — écartée par défaut : le `satisfies` serveur + le contrat partagé suffisent ; on garde la possibilité d'asserts `xxxResponseSchema.parse()` **opportunistes dans les tests API** sans payer le coût en prod.

## Consequences

- Nouveau package `packages/api-contracts` (calqué sur `@boreas/opml` : sources TS, `exports { ".": "./src/index.ts" }`), ajouté aux dépendances `workspace:*` d'`apps/api` et `apps/web`.
- **Hors périmètre** : `routes/img.ts` (sert des octets, pas du JSON) et les réponses sans corps typable (redirections 302, 204).
- **Pièges figés par le contrat** : les timestamps wire sont des `z.string()` ISO (jamais `z.coerce.date()`, qui casserait `formatRelativeTime` et le curseur keyset) ; `byFolder[].folderId` est non-null côté wire alors que drizzle l'infère `string | null` (garanti par `isNotNull` au runtime) — seul endroit où la route fait un mapping explicite plutôt que de s'en remettre à `satisfies`.
- Les deux `SubscribeOutcome` homonymes (type interne API vs modèle de vue web) **ne sont pas** déplacés : aucun n'est la forme wire.
- Couverture de contrat : tests unitaires des schémas dans le package + asserts `parse()` opportunistes dans les suites API.
