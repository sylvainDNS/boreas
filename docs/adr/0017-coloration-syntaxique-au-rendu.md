# Coloration syntaxique des articles au rendu (côté client)

Le contenu d'article contient des blocs de code qu'on veut **colorer selon leur langage**.
La coloration produit des `<span>` de tokens : le CSS seul ne peut pas les créer, il faut un
tokeniseur (highlight.js). La décision retenue est de **colorer côté client, au moment du
rendu**, par un **transform déclaratif** : `ReaderPane` rend désormais le HTML d'article via
un pipeline **unified/rehype** (`rehype-parse` → `rehype-highlight` (lowlight) → `rehype-react`)
au lieu de `dangerouslySetInnerHTML`. Le pipeline est **lazy-loadé** (code-split) ; le langage
est **auto-détecté** (`detect: true`, restreint à un `subset`) car le sanitizer retire la classe
`language-*`. La palette est celle de **GitHub** (clair/sombre), exposée en variables CSS
(`--tok-*` / `--code-*`) clé sur `data-theme`, le `.reader-prose` ne faisant que **colorer** les
classes `.hljs-*`. Le HTML reste **sanitizé côté serveur** (ADR 0007) : ce transform est
purement présentationnel et ne rejoue aucune sécurité.

## Considered Options

- **Coloration à l'ingestion (serveur), spans stockés dans R2** — rejeté : imposerait de
  **re-traiter tout le contenu déjà stocké**, de **modifier le sanitizer** pour laisser passer
  les spans (surface sensible), et **coupler la présentation au contenu stocké** (toute retouche
  de style = re-traitement). Le store doit rester neutre vis-à-vis de la présentation.
- **`querySelectorAll` + highlight.js dans un `useEffect`** — rejeté : mutation **impérative**
  post-rendu, fragile (re-renders, double-invocation en `StrictMode`) et hors du modèle React.
  Le transform déclaratif au rendu (fonction pure mémoïsée) n'a pas ces défauts et **évite tout
  flash** code-nu → coloré.
- **Préserver l'indice de langage via le sanitizer** (mapper `class="language-x"` → attribut sûr)
  — écarté en v1 : touche le sanitizer et ne profite qu'au contenu neuf ; l'auto-détection
  couvre tout l'existant sans changement serveur. Reste une piste si la précision est jugée
  insuffisante.

## Consequences

- La coloration **fonctionne sur tous les articles existants** sans migration, et le **sanitizer
  reste inchangé**.
- Coût d'un **bundle client** (unified/rehype/lowlight) **chargé à la demande** via `React.lazy`
  à l'ouverture du lecteur.
- L'auto-détection peut se tromper sur des snippets très courts (compromis assumé en v1) ;
  le `subset` de langages limite les erreurs et le poids.
- `dangerouslySetInnerHTML` disparaît du lecteur au profit d'un rendu en éléments React (plus sûr).
- Si l'on veut des **langages exacts** plus tard, préserver l'indice de langage dans le sanitizer
  (option ci-dessus) se branche sur le même pipeline.
