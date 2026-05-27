# Extraction du contenu complet à l'ouverture

Beaucoup de flux ne livrent qu'un résumé ; on veut pouvoir lire l'article complet dans l'app. L'extraction du plein contenu (type Readability) coûte 1 sous-requête + du CPU lourd par article. On l'effectue donc **paresseusement, à la première ouverture** d'un Article, puis on met le résultat en cache — **jamais à l'ingestion**.

## Considered Options

- **Extraction systématique à l'ingestion** — rejeté : ferait exploser les limites par invocation du free tier (10 ms CPU, 50 sous-requêtes), surtout lors d'un abonnement en masse, et forcerait Queues + plan payant (contredit l'ADR 0002).
- **Extraction à la sauvegarde uniquement** — rejeté : la lecture courante resterait tronquée pour les flux partiels.

## Consequences

- Le coût d'extraction est borné à ce que l'utilisateur **lit réellement**, throttlé au rythme humain (un article à la fois).
- Un Article jamais ouvert n'a pas de plein contenu stocké.
