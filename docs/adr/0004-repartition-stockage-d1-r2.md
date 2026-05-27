# Répartition du stockage D1 / R2

Le HTML plein extrait est volumineux ; on veut garder le store relationnel léger. **D1** héberge les métadonnées de l'Article (identité, titre, auteur, date, URL, **résumé fourni par le flux**, états `Read`/`Saved`, clé de l'objet R2). **R2** héberge le **HTML plein extrait** (écrit à l'ingestion, ADR 0003, objet keyé `articles/{id}.html`). **KV n'est pas utilisé.**

## Considered Options

- **Tout en D1** — viable (5 Go inclus) mais alourdit les lignes et les requêtes de liste.
- **KV** — écarté : sa cohérence *eventually consistent* est inadaptée à l'état lu/non-lu, et les ETag/Last-Modified tiennent sur la ligne `feed` en D1.

## Consequences

- R2 a son propre quota gratuit et **n'exige pas le Workers Paid** ni de frais d'egress → cohérent avec la portabilité free-tier (ADR 0002).
- **Cohérence deux-stores** : supprimer un Article (purge Read & non-Saved > 60 j) doit effacer l'objet R2 associé — delete R2 inline dans la purge + balayage périodique des orphelins en filet.
- Une lecture R2 supplémentaire à chaque ouverture d'article (latence de l'ordre de quelques dizaines de ms).
