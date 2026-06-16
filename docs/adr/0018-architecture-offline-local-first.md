# Architecture offline local-first (réplica IndexedDB + delta sync + push)

Boréas évolue en **PWA installable** visant la **lecture hors-ligne complète** (listes, détail,
images), une **synchro automatique à la reprise de connexion** et des **notifications « article
prêt à lire »**. La décision structurante est le **local-first** : l'UI lit **toujours** un
**réplica local IndexedDB** (en ligne comme hors-ligne) ; un **moteur de sync** isolé est le
**seul** module à connaître le backend. Toutes les vues (home, non-lus, flux, dossier, Saved)
deviennent des **projections locales** (`read`/`saved`/`feed_id`/dossier/tri) sur un **unique jeu
d'articles répliqué** — elles fonctionnent hors-ligne sans avoir été ouvertes. Cible de
conception : **Android/Chrome** (Background Sync, Periodic Sync, Web Push complets) ; iOS reste un
**best-effort non testé** (sync au premier plan, push seulement si installée).

**Frontière distant/local.** Le seam d'accès aux données existe déjà : les `queryOptions` de
`apps/web/src/lib/{articles,feeds,folders}.ts` deviennent un **repository** dont le `queryFn` lit
le store local au lieu d'appeler `apiFetch` ; les composants `useQuery`/`useInfiniteQuery` ne
changent pas. Le **client distant** (`lib/api.ts` + `@boreas/api-contracts`) n'est utilisé **que**
par le moteur de sync (`lib/sync/*`) — et, exception assumée, par les **ops Feeds/Folders
online-only** (ajouter/déplacer/supprimer, qui exigent le réseau). Pas de switch runtime « si
online lis distant sinon local » : ce serait réintroduire les deux chemins de code et leurs bugs
de cohérence.

**Corpus à deux étages.** Métadonnées = **tout** ce que le serveur détient (déjà borné par la
rétention) ; contenu lourd (HTML R2 + images) = **non-lus + Saved**, sans plafond. Le contenu d'un
article devenu **Read non-Saved** est **évincé localement** (GC) ; ses métadonnées ne partent qu'à
réception d'un tombstone.

**Sync descendante (delta).** `GET /api/sync?since=<updated_at epoch-ms>` renvoie les upserts
(feeds/folders/articles métadonnées) + des **tombstones**. Migration D1 nécessaire (étend ADR
0011) : `updated_at` (epoch-ms, bumpé à chaque écriture) sur `articles`/`feeds`/`folders`, et une
table `tombstones (entity_type, entity_id, deleted_at)` alimentée par la purge et les Delete (qui
faisaient un hard-delete sans trace). `since` vide = sync initiale complète paginée ; `since` plus
ancien que la fenêtre de rétention des tombstones → réponse « curseur périmé » → le client **wipe
+ resync complet**.

**Sync montante (outbox).** Les mutations de lecture (Read/Saved/mark-all-read) sont appliquées
**optimistement au réplica** puis empilées dans une **outbox** IndexedDB, **flushée à la
reconnexion** (event `sync`, sinon `online`/focus). On **pousse l'outbox avant de pull** le
delta ; tant qu'une entité a une entrée non-ackée, les upserts descendants la concernant sont
ignorés. Conflits = **last-write-wins** (états booléens, **mono-utilisateur**). **Read** cesse
d'être un effet de bord du `GET /api/articles/:id` (#7) et devient une **mutation client explicite
à l'ouverture** — sans quoi pré-télécharger le contenu des non-lus les passerait tous en Read.

**Contenu & images.** HTML stocké en IndexedDB, récupéré via un **batch `POST
/api/articles/content {ids[]}`** (sans effet Read). Images servies via le proxy existant
`/api/img` (URLs HMAC **déterministes et stables**, ADR 0009) et mises en **Cache Storage** du
service worker en **cache-first** ; pré-chauffées en parsant le HTML pour ses `src`. Le service
worker est bâti avec **`vite-plugin-pwa` en mode `injectManifest`** (Workbox gère le precache du
shell + le versioning ; on écrit la logique custom : `push`, cache-first images, Background Sync,
download).

**Notifications.** Le **consommateur de Queue** (`ingestion.ts`, ADR 0002) émet **un Web Push par
feed** ayant des articles net-new. Le handler `push` **télécharge d'abord** (delta + contenu +
images) **puis** affiche la notification (titre = feed, corps = titre d'article + « +N autres »,
tag = feedId, tap → `/feeds/:feedId`) : la notif ne s'affiche que quand c'est **réellement lisible
hors-ligne**, ce qui respecte aussi la règle Chrome « un push aboutit à une notification
visible ». Nouvelle table `push_subscriptions` ; clés **VAPID** (privée en secret Worker,
réutilisant le pattern de secrets de l'ADR 0005). Permission via **toggle explicite dans
Réglages**.

**Boot & auth hors-ligne.** Le guard `_shell.tsx` devient **adaptatif** : en ligne il valide la
session côté serveur (inchangé, ADR 0005) ; hors-ligne il fait confiance à une **session réussie
antérieure** mémorisée localement et rend depuis le réplica. À la reconnexion, le premier appel
revalide ; un `401` → `/login`, l'outbox étant conservée à travers la ré-auth.
`navigator.storage.persist()` est demandé au boot pour limiter l'éviction.

## Considered Options

- **Cache-au-fil-de-l'eau** (persistance du cache React Query + SW cache des réponses API) —
  rejeté : ne rend lisible que ce qui a été **visité** en ligne ; détail et images des articles
  jamais ouverts manquent ; les vues de liste sont des **caches de requêtes distincts** (par clé)
  impossibles à synthétiser sans les avoir fetchés. Ne satisfait ni « lire dans le métro sans rien
  avoir ouvert », ni « notif d'un article prêt à lire ».
- **Réplica de secours** (online lit l'API, offline lit le réplica) — rejeté : **deux chemins de
  code**, divergences optimistic-update/réplica, réconciliation fragile, et il faut quand même
  pré-remplir chaque vue. Le local-first **lit toujours local** et supprime cette classe de bugs.
- **Curseur de delta = séquence monotone globale** — écarté au profit d'`updated_at` epoch-ms :
  pas de concurrence (mono-user) qui justifierait un compteur atomique en D1.
- **Deletions par soft-delete `deleted_at`** sur chaque table — écarté au profit d'une table
  `tombstones` dédiée : tables principales propres, un seul endroit à lire pour le delta.
- **Feeds/Folders mutables hors-ligne (via outbox)** — rejeté : certaines ops sont **impossibles**
  offline (ajouter un feed = le fetcher) et impliqueraient une exécution différée non désirée ;
  gardées **online-only**, désactivées hors-ligne, leurs changements **descendent** via le delta.
- **Better Auth** — rejeté : ne résout **rien** de l'offline (l'auth hors-ligne est un « trust
  local » côté client), entre en conflit avec les sessions **stateless** sans table (ADR 0005) et
  le **mono-user sans entité compte** (CONTEXT.md), et réintroduit les tables `user`/`session`
  écartées. Le déverrouillage **passkeys** reste une piste future **séparée**.
- **Images en blobs IndexedDB + réécriture des `src` en `blob:`** — écarté : code DOM au rendu +
  cycle de vie des object URLs, sans gain face au cache-first par URL stable.

## Consequences

- **Migration D1** (étend ADR 0011) : `updated_at` partout + table `tombstones` ; purge et Delete
  écrivent désormais un tombstone au lieu d'un hard-delete silencieux.
- **Nouveaux endpoints API** (Worker read-heavy, ADR 0006/0008) : `GET /api/sync`, `POST
  /api/articles/content`, enregistrement de subscription push ; **suppression de l'effet Read du
  `GET /api/articles/:id`** (#7) — contrat modifié, le Read passe côté client.
- **Compteurs de non-lus calculés localement** (le réplica a toutes les métadonnées) → l'usage
  d'affichage de `GET /api/articles/counts` disparaît ; exacts et offline gratuitement.
- **Le poll 60 s** (listes + counts) est remplacé par la sync au focus/online/push + un intervalle
  delta léger au premier plan.
- **La recherche devient offline** (s'exécute sur le réplica).
- **Web Push depuis un Worker** (VAPID JWT + chiffrement aes128gcm via WebCrypto) = **risque à
  dérisquer par un spike** ; **Periodic Background Sync** best-effort (gating Chrome). Push =
  chemin temps réel.
- **Stockage local** potentiellement important (non-lus sans plafond) ; mitigé par la rétention
  serveur, le GC local du contenu Read-non-Saved, et `storage.persist()`.
- **iOS** : pas de Background/Periodic Sync, push seulement si installée → sync au premier plan
  uniquement ; **non testé**.
- **Trappe de secours manuelle** (Réglages, « Forcer une resynchronisation ») : sœur déclenchée
  par l'utilisateur du wipe-resync auto sur curseur périmé, mais plus radicale (`deleteReplica` +
  réouverture vierge, robuste si la base est coincée) et avec **perte assumée de l'outbox** (les
  mutations Read/Saved non poussées partent au vidage). Désactivée hors-ligne.
- **CONTEXT.md inchangé** : aucun nouveau terme de domaine (le corpus offline est dérivé de
  `unread ∪ saved` ; « Read » garde son sens domaine, seul son mécanisme change). Le glossaire
  reste neutre vis-à-vis de l'implémentation.
