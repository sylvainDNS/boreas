# Architecture d'ingestion : Cron Trigger + Queues

L'ingestion repose sur un **Cron Trigger** (~5 min) qui sélectionne en D1 les Feeds *dus* (échéances `next_check_at` étalées) et **enqueue un message par Feed** dans une **Queue**. Un **consommateur** (handler `queue` du Worker d'ingestion) traite chaque message : *conditional GET* du Feed → parse → pour chaque nouvel **Article**, extraction du contenu complet + sanitization (ADR 0003, 0007) → upsert. La logique fetch+parse+extraction vit dans un **module pur** du package partagé. Le même Cron déclenche aussi la purge de rétention.

## Considered Options

- **Boucle cron concurrente sans Queues** — rejeté : l'extraction systématique (ADR 0003), surtout lors d'un import OPML/backfill, ferait exploser les limites CPU/sous-requêtes d'une invocation unique. Queues éclate la charge (un message/Feed) avec retries et backpressure natifs.
- **Durable Objects par flux (polling adaptatif)** — rejeté : intervalle fixe choisi.

## Consequences

- Dépend du plan **Workers Paid** (Queues), assumé en ADR 0012 — annule l'objectif initial de portabilité free-tier.
- Granularité **un message par Feed** : l'extraction des articles d'un Feed tient dans une invocation de consommateur (fenêtre d'items bornée) ; un import en masse se répartit sur autant de messages que de Feeds.
- Le module de fetch isolé reste le point de bascule : la migration boucle→Queues ne change que l'appelant.
