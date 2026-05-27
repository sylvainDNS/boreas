# Extraction systématique du contenu à l'ingestion

Le contenu complet de chaque nouvel **Article** est extrait (type Readability) **et** sanitizé (ADR 0007) **pendant l'ingestion** (dans le consommateur de Queue, ADR 0002), puis stocké en R2 (ADR 0004) — pour *tous* les articles, pas seulement ceux ouverts. La lecture est ainsi toujours instantanée et complète, et le corpus extrait est prêt pour une future recherche plein-texte.

## Considered Options

- **Extraction paresseuse à la première ouverture** — envisagé (plus économe : on n'extrait que ce qu'on lit) mais rejeté : ajoute une latence à la première ouverture et ne prépare pas la recherche ; l'expérience « tout est déjà prêt » est préférée.
- **Extraction systématique sur le free tier** — impossible : le parse Readability dépasse les 10 ms CPU/invocation du free. Levé par le passage au Workers Paid (ADR 0012, jusqu'à 30 s CPU/invocation).

## Consequences

- Coût CPU et stockage R2 à **chaque** ingestion d'article (plus seulement à la lecture) → consommation R2 plus élevée, bornée par la rétention 60 j ; à surveiller.
- L'extraction vit dans le chemin d'ingestion, plus dans le Worker API : `GET /articles/:id` ne fait que servir le contenu déjà stocké.
- Le miroir des **images** reste paresseux (mis en cache au premier rendu via le proxy, ADR 0009).
