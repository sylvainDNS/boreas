# Proxy d'images avec cache R2

Les images des articles sont servies via un endpoint **`/api/img`** plutôt qu'en hotlink direct, pour masquer l'IP/l'activité de lecture vis-à-vis des éditeurs et régler le mixed-content. Pour neutraliser le SSRF, les URLs d'images sont **signées (HMAC) lors de la sanitization serveur** (ADR 0007) et le proxy ne sert que des URLs pré-validées. Chaque image est **mise en cache dans R2** (clé = hash de l'URL source) : au premier accès on récupère et on stocke, ensuite on sert depuis R2. Les images des Articles **Saved** survivent ainsi à la disparition de la source.

## Considered Options

- **Hotlink direct + CSP** — rejeté : laisse fuir l'IP/activité de lecture aux éditeurs.
- **Proxy sans cache** — rejeté : refetch à chaque lecture, pas de durabilité.

## Consequences

- **R2 héberge désormais aussi les images** (`images/{hash}`), en plus du HTML extrait (étend l'ADR 0004) ; quota R2 gratuit (10 Go) consommé plus vite — à surveiller.
- **GC des images** à prévoir : une table de références `image ↔ article` permet, à la purge d'un Article, de décrémenter et de supprimer en R2 les images à zéro référence (sweep périodique). En v1, on peut tolérer l'accumulation d'orphelins (10 Go de marge) et différer le GC fin.
- La signature HMAC mutualise le secret déjà utilisé pour l'auth (ADR 0005).
