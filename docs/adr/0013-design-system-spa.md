# Design system et ossature du SPA

Avant de construire les vues, la revue de design (#4, tranche HITL) fige les fondations visuelles et de navigation, réutilisées par toutes les tranches suivantes. Trois choix sont arrêtés :

- **Tailwind CSS v4** comme couche de style, en configuration *CSS-first* : les **design tokens** vivent dans un bloc `@theme` (`apps/web/src/styles/app.css`) sous forme de variables CSS sémantiques (`--color-bg`, `--color-surface`, `--color-accent`, `--font-ui`, `--radius-card`, `--shadow-card`…). Les utilitaires Tailwind (`bg-surface`, `text-accent`, `rounded-card`) lisent ces variables.
- **Thème clair/sombre piloté par `data-theme`** sur `<html>` (et non par la media-query ni la classe `.dark`), via `@custom-variant dark`. La préférence (`light | dark | system`, alignée sur l'enum `settings.theme`) est résolue puis appliquée par `src/lib/theme.ts` ; le thème sombre ne fait que surcharger les variables couleur sous `[data-theme="dark"]`. Persistance `localStorage` pour l'instant ; la synchro serveur (`settings.theme`) viendra avec l'auth/les réglages.
- **TanStack Router** (file-based, plugin Vite) pour la navigation typée, en cohérence avec TanStack Query déjà en place. Layout commun via une route *pathless* `_shell` ; `/login` en est exclue.

La **direction visuelle retenue est « Moderne carte »** (parmi trois prototypées) : police **Figtree**, accent violet, articles en **cartes arrondies** avec ombres douces, cibles tactiles ≥ 44 px. Police servie via **Google Fonts**, rendue **first-party par Cloudflare Fonts** en prod (vie privée, pas de requête directe vers Google).

## Considered Options

- **CSS pur + custom properties** — rejeté : tokens triviaux mais plus de plomberie manuelle (layout, responsive, états) que Tailwind, pour un mono-développeur.
- **CSS Modules** — rejeté : bon scoping mais multiplie les fichiers et n'apporte pas de système d'utilitaires.
- **Thème par media-query / classe `.dark`** — rejeté : on doit pouvoir **forcer** clair ou sombre indépendamment du système (préférence « system » incluse), ce que `data-theme` permet directement.
- **React Router** — rejeté : plus répandu mais moins intégré à l'écosystème TanStack déjà adopté.
- **Polices self-hostées / stack système** — écartées au profit de Google Fonts + Cloudflare Fonts : contrôle typographique sans fuite de données ni poids de build.

## Consequences

- Une **action manuelle hors-code** : activer *Speed → Optimization → Cloudflare Fonts* sur la zone `sylvaindenyse.me` pour que les polices soient servies first-party. Sans cela, Figtree est chargée depuis Google (fonctionnel, mais sans le bénéfice vie privée).
- `routeTree.gen.ts` est **généré** par le plugin (au `dev`/`build`) et commité ; il est exclu du lint Biome (`**/*.gen.ts`).
- Le parseur CSS de Biome doit activer `css.parser.tailwindDirectives` pour accepter `@theme`/`@custom-variant`.
- Les conventions de composants pour les tranches de vues sont documentées dans `docs/design-conventions.md`.
- Le responsive vise la **parité mobile/desktop** : 3 zones ≥ `lg`, drill-down liste→lecteur + sidebar en tiroir en dessous.
