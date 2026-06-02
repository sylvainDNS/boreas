# Conventions de design du SPA

Référence pour les tranches de vues (#6–#18). Décision de fond : [ADR 0013](adr/0013-design-system-spa.md). Direction retenue : **Moderne carte** (Figtree, accent violet, cartes arrondies, cibles ≥ 44 px).

## Design tokens

Définis dans `apps/web/src/styles/app.css` (bloc `@theme`), consommés via les utilitaires Tailwind. **Ne jamais coder une couleur en dur** : toujours passer par un token.

| Token | Utilitaires | Usage |
| --- | --- | --- |
| `--color-bg` | `bg-bg` | Fond de l'app / panneaux de fond |
| `--color-surface` | `bg-surface` | Cartes, sidebar, surfaces élevées |
| `--color-surface-2` | `bg-surface-2` | Survol, état actif, pastilles |
| `--color-border` | `border-border` | Bordures et séparateurs |
| `--color-text` | `text-text` | Texte principal |
| `--color-muted` | `text-muted` | Texte secondaire, méta |
| `--color-accent` / `--color-accent-hover` / `--color-accent-fg` | `bg-accent`, `text-accent`, `text-accent-fg` | Actions primaires, sélection |
| `--font-ui` / `--font-read` | `font-ui` / `font-read` | UI / contenu de lecture |
| `--radius-card` | `rounded-card` | Rayon standard des surfaces |
| `--shadow-card` / `--shadow-pop` | `shadow-card` / `shadow-pop` | Élévation cartes / overlays |

Les valeurs couleur ont une variante sombre (surcharge sous `[data-theme="dark"]`). Un nouveau token couleur **doit** définir ses deux variantes.

## Thème

- Piloté par `data-theme` sur `<html>` (`src/lib/theme.ts`). Ne pas utiliser `prefers-color-scheme` directement dans les composants ni la classe `.dark`.
- Variante sombre dans le markup : préfixe `dark:` (ex. `dark:bg-surface-2`). En général inutile puisque les tokens basculent seuls — n'employer `dark:` que pour un ajustement spécifique.
- Lire/écrire la préférence via le hook `useTheme()`.

## Responsive (parité mobile/desktop)

- Breakpoint pivot : **`lg`** (≥ 1024 px) = disposition trois zones complète.
- En dessous de `lg` : la sidebar devient un **tiroir** (`AppShell`), et les vues liste+lecteur basculent en **drill-down** (liste seule, puis lecteur plein écran avec bouton retour — cf. `ArticleListView`).
- Cibles tactiles **≥ 44 px** (`min-h-11` / `size-11`). Utiliser `Button` et `IconButton` qui les garantissent.

## Composants

- **Primitives** (`src/components/ui/`) : `Button` (variants `primary | outline | ghost`), `IconButton` (`label` obligatoire → `aria-label`), `CountBadge`, `FeedChip`. À étendre ici plutôt que de réinventer.
- **Régions** (`src/components/`) : `AppShell` (ossature + tiroir), `Sidebar`, `ArticleListView` (liste + lecteur responsive), `ArticleCard`, `ReaderPane`, `EmptyState`, `ThemeToggle`.
- Accessibilité : icônes décoratives `aria-hidden` + libellé `sr-only` ; respecter les règles a11y de Biome (domaine `react`).

## Ajouter une vue

1. Créer un fichier sous `src/routes/`. Vue applicative → préfixe `_shell.` (hérite sidebar + shell) ; page hors-shell (ex. `/login`) → à la racine de `routes/`.
2. `export const Route = createFileRoute("/_shell/…")({ component })`. Le `routeTree.gen.ts` est régénéré automatiquement par le plugin Vite.
3. Pour une vue de lecture, réutiliser `ArticleListView` (liste + lecteur + drill-down déjà gérés). Pour une vue mono-colonne (réglages…), suivre le gabarit de `_shell.settings.tsx`.
4. Ajouter le lien de navigation dans `Sidebar` si nécessaire (`<Link>` + `activeProps`).
5. Brancher les données via TanStack Query (remplacer les imports de `src/mock/`).

## À retenir

- Données actuelles = **mock** (`src/mock/`), à remplacer par l'API au fil des tranches.
- Le contenu d'article se met en forme avec la classe `.reader-prose` (panneau lecteur).
