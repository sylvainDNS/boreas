# Boréas

Boréas — lecteur de flux RSS mono-utilisateur, déployé sur la plateforme Cloudflare. Un seul utilisateur implicite : pas de notion de compte ni d'utilisateur dans le modèle de domaine.

## Language

**Feed**:
Une source de contenu distante à laquelle l'utilisateur est abonné, identifiée par son URL. Porte aussi les réglages personnels (la distinction source/abonnement est fusionnée, le mono-utilisateur n'ayant qu'un seul abonné).
_Avoid_: Subscription, Source, Channel

**Article**:
Une unité de contenu individuelle publiée par un **Feed** (texte/HTML). Contenu textuel uniquement ; une enclosure éventuelle est conservée comme simple métadonnée (lien + type), sans lecteur média.
_Avoid_: Item, Entry, Post

**Folder**:
Un regroupement de plusieurs **Feeds** (jamais d'Articles). Hiérarchie plate (un seul niveau, pas d'imbrication). Un **Feed** appartient à au plus un **Folder**. Ouvrir un **Folder** affiche les **Articles** agrégés de tous ses **Feeds**.
_Avoid_: Category, Group, Label

### États d'un Article

**Read**:
État indiquant que l'utilisateur a consulté l'**Article** (booléen). Probablement positionné automatiquement à l'ouverture/au scroll.
_Avoid_: Seen, Viewed

**Saved**:
État indiquant que l'utilisateur a volontairement mis un **Article** de côté pour le conserver/retrouver hors du flux. Concept unique de mise de côté.
_Avoid_: Starred, Favorite, Bookmark, Read-later

### Actions sur un Feed

**Unsubscribe** (Désabonnement):
Action non destructive : arrête le polling du **Feed**, purge ses **Articles** non-**Saved**, mais **conserve les Saved** (le Feed est masqué, pas effacé). Réversible.
_Avoid_: Delete, Remove (réservés au hard-delete)

**Delete** (Suppression):
Action destructive et explicite : efface le **Feed** et **tous** ses **Articles**, **Saved compris**. Irréversible.
_Avoid_: Unsubscribe

## Relationships

- Un **Feed** publie zéro ou plusieurs **Articles**
- Un **Article** appartient à exactement un **Feed**
- Un **Feed** appartient à au plus un **Folder** ; un **Folder** contient zéro ou plusieurs **Feeds**

## Example dialogue

> **Dev :** « Quand je marque un **Article** comme **Read**, il disparaît ? »
> **Domaine :** « Non — il reste, juste grisé. Il n'est supprimé que s'il est **Read** *et* non **Saved** depuis plus de 60 jours. »
> **Dev :** « Et si je le passe **Saved** ? »
> **Domaine :** « Alors il est gardé indéfiniment, jamais purgé. »
> **Dev :** « Un **Folder**, ça contient des **Articles** ? »
> **Domaine :** « Non — un **Folder** regroupe des **Feeds**. Les **Articles**, tu les vois en ouvrant un **Feed** ; ouvrir un **Folder** affiche ceux de tous ses **Feeds** d'un coup. »

## Flagged ambiguities

- "Subscription" : fusionné dans **Feed** — il n'existe qu'un seul abonné, une entité distincte n'apporterait qu'une jointure inutile.
- **Folder** ≠ vue des Articles d'un Feed : un **Folder** regroupe des **Feeds**. La liste des Articles d'un flux, c'est le **Feed** lui-même.
- **Label** : concept envisagé (étiquettes transversales sur les Feeds) puis **abandonné** pour rester simple — un seul axe d'organisation, le **Folder**.
- **Unsubscribe** vs **Delete** : Unsubscribe est réversible et **préserve les Saved** ; Delete est destructif et les efface.
