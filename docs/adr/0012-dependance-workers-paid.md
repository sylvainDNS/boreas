# Dépendance assumée au plan Workers Paid

Boréas dépend désormais du plan **Workers Paid** (~5 $/mois), abandonnant l'objectif de portabilité free-tier. Motif principal : l'**extraction Readability** (ADR 0003) dépasse la limite de **10 ms CPU par invocation** du free tier, alors que le payant offre jusqu'à 30 s ; l'**envoi d'email** du magic link (ADR 0005) conforte ce choix.

## Consequences

- **Queues** et **Durable Objects** deviennent disponibles sans coût marginal — Queues est utilisé pour l'ingestion (ADR 0002).
- L'usage perso reste dans les **quotas inclus** du plan payant (CPU, Queues, D1, R2…) ; à surveiller, mais aucune facturation à l'usage attendue.
- Annule la justification « free-tier » initiale des ADR 0002 et 0003, révisés en conséquence.
