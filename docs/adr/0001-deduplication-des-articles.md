# Déduplication des Articles

Les flux RSS/Atom exposent les identifiants de façon inégale (certains n'ont pas de `guid`, d'autres le changent à chaque édition ou le réutilisent). Pour éviter les doublons et les non-lus qui ressurgissent, l'identité d'un **Article** est la clé `(feed_id, clé)` où `clé = guid` si présent, sinon `link`, sinon `hash(titre + date)`. L'ingestion fait un *upsert* sur cette clé : si le contenu change à la source, l'Article est mis à jour **sans** réinitialiser son état `Read`.

## Consequences

- La déduplication est scopée **par flux** : le même lien dans deux flux donne deux Articles (voulu).
- Le `hash` de repli n'utilise que des **champs stables fournis par le flux** (titre + date du flux ; à défaut titre + contenu) — **jamais** `fetched_at`, sinon la clé changerait à chaque fetch et recréerait des doublons.
- Changer de stratégie de clé après coup risque de **recréer des doublons** sur les flux déjà ingérés — décision coûteuse à revenir dessus.
