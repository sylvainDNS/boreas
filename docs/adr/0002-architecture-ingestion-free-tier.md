# Architecture d'ingestion compatible free-tier

L'usage réel du compte Cloudflare tient dans le free tier ; on veut préserver la liberté de résilier l'abonnement Workers Paid (5 $/mois). L'ingestion des flux se fait donc ainsi : un **Cron Trigger** (~5 min) sélectionne en D1 les Feeds *dus*, qui sont récupérés (en *conditional GET*) dans une **boucle concurrente au sein du Worker cron**. Pas de Queues en v1. La logique de fetch d'un flux est isolée dans un **module pur** (entrée : un Feed ; sortie : des Articles), de sorte qu'un futur passage à Queues ne soit qu'un changement d'appelant.

## Considered Options

- **Queues (fan-out 1 message/flux)** — rejeté en v1 : verrouille la dépendance au Workers Paid sans bénéfice pour des dizaines de flux, qui tiennent dans une invocation (50 sous-requêtes en free, 1000 en payant).
- **Durable Objects par flux (alarmes adaptatives)** — rejeté : le polling adaptatif n'est pas requis, on a choisi un intervalle fixe.

## Consequences

- Le rationale (facturation, portabilité free-tier) est **invisible dans le code** : sans cet ADR, un lecteur sur plan payant se demanderait pourquoi on n'utilise pas Queues.
- Si la collection franchit l'échelle (centaines+ de flux), basculer vers Queues est un changement localisé grâce au module de fetch isolé.
