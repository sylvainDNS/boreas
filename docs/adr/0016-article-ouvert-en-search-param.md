# Article ouvert encodé en search param `?article`, pas en route imbriquée

L'**Article** ouvert dans le lecteur vivait dans un `useState` local à
`ArticleListView`, hors de l'URL : le bouton retour du navigateur ne ramenait
jamais à la liste (très visible en mobile, où la liste→lecteur est un drill-down)
et un Article n'était pas deep-linkable. On l'encode désormais dans l'URL via le
**search param `?article=<id>`** ajouté à la route liste courante (`/`,
`/feeds/$feedId`, `/folders/$folderId`, `/saved`), validé par un
`validateArticleSearch` partagé.

Le path encode **quelle liste** ; l'Article ouvert est une **sélection
transversale au sein de cette liste**, pas un sous-niveau hiérarchique propre à un
Feed — c'est sémantiquement un search param, et le composant unique partagé
`ArticleListView` (#47) y est déjà taillé. Chaque ouverture **push** une entrée
d'historique (back rejoue les Articles puis revient à la liste).

## Considered Options

- **Route imbriquée `/feeds/$feedId/articles/$articleId`** — rejetée : il
  faudrait dupliquer la route détail sous chaque parent (feeds, folders, saved,
  home ≈ ×4), chacune re-câblant le layout liste+lecteur et maintenant le scope
  parent monté pour garder la liste visible derrière — à rebours de la
  centralisation visée par #47. URL plus « propre » sans bénéfice ici.
- **Sélection en state local (statu quo)** — rejetée : c'est la cause du bug
  (back système hors-jeu, pas de deep-link).

## Consequences

- `ArticleDetailResponse` (`GET /api/articles/:id`) gagne `saved` + `unread`
  (état pré-marquage Read) : le lecteur se rend depuis le seul `id` quand l'item
  n'est pas dans la page chargée (refresh sur Article paginé, lien collé), sans
  dépendre du cache de liste. Ajout additif, rétro-compatible.
- `ArticleListView` se couple au routeur (`useSearch`/`useNavigate`) ; comme il
  est monté par 4 routes différentes, `useNavigate()` n'est pas lié et se type sur
  la racine (search `never`) — on le re-type localement sur `?article`.
- Changer de scope via la sidebar efface `?article` gratuitement : les `<Link>`
  TanStack n'héritent pas des search params.
