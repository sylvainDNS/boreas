# Tri de la liste d'Articles par date de publication

La rivière était triée par `fetched_at` (date d'ingestion), pas par date de publication. Au premier backfill d'un Feed, tous ses Articles partagent le même `fetched_at` ; le départage tombait alors sur `id` (un UUID aléatoire), donnant un ordre de publication apparemment aléatoire. De plus l'UI affichait `published_at` alors que le tri portait sur `fetched_at` — la position d'un Article ne correspondait pas à la date affichée.

On trie désormais par **date de publication décroissante**, avec une date d'affichage **cohérente avec la clé de tri**.

## Décision

- **Clé de tri** : `COALESCE(published_at, fetched_at) DESC, id DESC`. `fetched_at` étant `NOT NULL`, la clé est toujours non-null.
- **published_at NULL** (flux sans `<pubDate>` ou date illisible) → fallback sur `fetched_at`, pour le tri **et** l'affichage.
- **Dates futures** (flux menteur / décalage d'horloge) → plafonnées **cosmétiquement côté front** (« maintenant » au lieu de « dans 1 an »). Le tri SQL conserve la date brute.
- **Pas de colonne dérivée** : l'expression de tri est calculée à la volée dans la requête ; pas de migration de données.
- **Curseur keyset** : porte la clé de tri `COALESCE(published_at, fetched_at)` (au lieu de `fetched_at` seul), sinon la pagination produirait trous et doublons dès que `published_at` et `fetched_at` divergent.
- **Contrat API** : `fetchedAt` est exposé dans `ArticleListItem` pour que le front reconstruise la date d'affichage `publishedAt ?? fetchedAt`.

## Considered Options

- **Garder le tri par `fetched_at`** — rejeté : ne correspond ni à l'attente de l'utilisateur ni à la date affichée ; c'est la cause du bug.
- **Colonne `display_date` calculée à l'ingestion, indexée** — rejeté pour l'instant : migration + backfill pour un gain de perf inutile à l'échelle mono-utilisateur (rétention 60 j). Réenvisageable si le volume grandit.
- **Plafonner les dates futures en base** — rejeté : ajoute de la complexité d'ingestion (clamp + seuil) pour un cas rare ; on assume qu'un Article à date future reste épinglé en tête, le front corrigeant seulement le libellé.

## Consequences

- Un Article à `published_at` futur reste **épinglé en tête** de la liste triée (le clamp n'est que cosmétique). Compromis accepté, cas rare.
- L'ORDER BY sur `COALESCE(...)` n'est pas servi par l'index `articles_unread_keyset (read, fetched_at, id)` : full-scan + tri. Négligeable au volume actuel ; un index d'expression `(read, COALESCE(published_at, fetched_at), id)` reste une option future.
- Le format du curseur (base64 `"{clé}|{id}"`) est inchangé, mais sa **sémantique** change : un curseur émis par l'ancienne version (valeur = `fetched_at`) reste décodable et dégrade proprement (au pire une page légèrement décalée), sans erreur.
