# Ordre manuel des Folders et Feeds par rang fractionnaire

Le redesign du menu de navigation permet de **réordonner manuellement** les **Folders** entre eux **et** les **Feeds** à l'intérieur de leur conteneur (un Folder ou la zone « sans dossier »), par drag-n-drop. L'ordre était jusqu'ici **alphabétique** côté serveur (folders, `orderBy(asc(name))`) et **non explicite** (feeds, ordre du tableau renvoyé).

On persiste l'ordre manuel via un **rang fractionnaire** — une chaîne lexicographique type *fractional indexing* / LexoRank — porté par une **nouvelle colonne de rang** sur `folders` et `feeds`. Réordonner recalcule le **seul rang de l'item déplacé** (entre ses deux voisins) : **une seule ligne réécrite, un seul `updated_at` bumpé**. C'est cohérent avec la sync delta local-first (ADR 0018) — churn minimal, faible surface de conflit multi-appareils, rééquilibrage rare.

## Considered Options

- **Entier `position` avec renumérotation des frères** — rejeté : chaque réorg réécrit N lignes → N `updated_at` bumpés, churn de sync et surface de conflit multi-appareils accrus (ADR 0018), sans gain face à un rang fractionnaire qui reste simple.
- **Entier espacé (pas de 1000)** — écarté : repousse mais n'élimine pas la renumérotation (rééquilibrage à épuisement d'écart), pour une complexité comparable au rang fractionnaire qui, lui, ne renumérote qu'en cas de collision rare.
- **Ordre dérivé (alpha / date de création) sans persistance** — rejeté : c'est précisément ce qu'on remplace ; ne permet pas l'ordre choisi par l'utilisateur.

## Consequences

- **Migration D1** (étend ADR 0011 / 0018) : colonne de rang (TEXT) sur `folders` et `feeds`, incluse dans le delta (`GET /api/sync`) ; **backfill** d'un rang initial (dérivé de l'ordre alpha actuel pour les folders, d'un ordre stable pour les feeds).
- **Contrats API** (ADR 0014) : `GET /api/feeds` et `/api/folders` renvoient le rang et trient par rang ; nouveau champ/endpoint pour persister un réordonnancement (PATCH du rang). `POST /api/feeds` doit aussi accepter un `folderId` (création « + » pré-scopée dans un dossier) et attribuer un rang.
- **Deux axes de position indépendants** (dossiers ; flux par conteneur). Déplacer un flux d'un dossier à l'autre = changement de `folder_id` **et** réattribution de rang dans le conteneur cible (pattern sortable multi-conteneurs de dnd-kit).
- **Conflits multi-appareils** = last-write-wins par ligne (mono-user, ADR 0018) : deux réorgs concurrentes peuvent produire un ordre transitoire non désiré, jamais une corruption ; auto-réparé au prochain drag.
- Choix d'une lib de rang (ex. `fractional-indexing`) vs implémentation maison à trancher à l'implémentation.
