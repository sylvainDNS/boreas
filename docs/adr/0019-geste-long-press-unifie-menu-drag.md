# Geste long-press unifié sur mobile (menu contextuel + drag)

Le redesign du menu de navigation **retire le kebab visible** des lignes Feed/Folder : les actions passent par un **menu contextuel** (clic droit sur desktop, long-press sur mobile). Or le drag-n-drop (déplacer un flux, réordonner dossiers et flux, cf. ADR 0020) arme déjà le **long-press ~250 ms** du `PointerSensor` de `@dnd-kit/react`. Sur mobile, un même geste devrait donc à la fois ouvrir le menu **et** déclencher un drag — collision frontale.

On adopte un **geste long-press unifié, style iOS** : l'appui long « soulève » la ligne et présente le menu contextuel ; si le doigt **franchit un seuil de déplacement** avant relâchement, l'interaction **bascule en drag** à la place. Un seul geste sert les deux intentions, sans affordance visible permanente. Sur desktop, aucune collision : clic droit = menu, drag = déplacer/réordonner. L'accès clavier est préservé par un **déclencheur de menu révélé au focus** (focus-visible) + touches **Menu / Shift+F10**.

## Considered Options

- **Mode « Réorganiser » explicite** (long-press = menu toujours ; drag seulement dans un mode dédié entré depuis le menu) — rejeté : geste lourd, deux étapes pour réordonner, état modal à gérer.
- **Garder long-press = drag + kebab visible pour le menu** — rejeté : contredit l'objectif d'épurer la ligne (affordance permanente, le compteur/dot/kebab étant précisément ce qu'on enlève).
- **Affordance « ⋯ » minimale visible sur mobile** — rejeté : réintroduit le bouton qu'on supprime, pour un demi-gain.

## Consequences

- **Code custom autour du `PointerSensor`** : `@dnd-kit/react` ne fournit pas nativement « lift → menu puis bascule drag au déplacement ». Il faut un capteur/handler qui arme un timer long-press, ouvre le menu, et convertit en drag si le pointeur dépasse le seuil avant relâchement. **Risque tactile à dérisquer par un spike/prototype.**
- Sur desktop, l'événement `contextmenu` natif est intercepté pour le menu ; le seuil d'activation du `PointerSensor` continue de distinguer clic (navigation via le `Link`) et drag.
- **A11y** : déclencheur de menu focusable révélé au focus + `Shift+F10`/touche Menu ; le réordonnancement clavier reste assuré par le `KeyboardSensor` existant (focus + espace + flèches).
- **Difficilement réversible** une fois le muscle-memory installé — d'où cet ADR.
