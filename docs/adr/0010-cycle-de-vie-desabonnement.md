# Cycle de vie : désabonnement vs suppression d'un Feed

Se désabonner d'un Feed ne doit pas faire perdre les Articles que l'utilisateur a délibérément **Saved**. On distingue donc deux actions : **Unsubscribe** (non destructif) arrête le polling et purge les Articles non-Saved du Feed (+ leurs objets R2), mais **conserve les Saved** et garde la ligne Feed (masquée) pour préserver leur contexte ; **Delete** (destructif, explicite, confirmé) efface le Feed et tous ses Articles, Saved compris.

## Considered Options

- **Suppression totale unique** — rejeté : perte irréversible des sauvegardes, en contradiction avec la sémantique de `Saved`.
- **Soft-delete (tout conserver)** — rejeté : n'offre aucun gain de place et brouille la liste.

## Consequences

- La ligne Feed survit à un Unsubscribe (état masqué) → les Saved gardent leur `feed_id` valide sans dénormalisation.
- La purge d'Unsubscribe réutilise la même logique de cohérence deux-stores que la purge 60 j (ADR 0004) et le GC d'images (ADR 0009).
- Supprimer des Saved n'est possible que via Delete explicite — décision irréversible, donc confirmée en UI.
