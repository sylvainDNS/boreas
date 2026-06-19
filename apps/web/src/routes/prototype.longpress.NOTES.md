# Spike #119 — Geste long-press unifié (menu + drag) — VERDICT

Spike jetable validant le geste « style iOS » de l'ADR 0019 avant l'intégration
(#120). Route : `/prototype/longpress` (jetable, hors `Sidebar`). `@dnd-kit/react@0.5.0`.

## Verdict : **GO** ✅

Le geste unifié est **faisable sans capteur custom**. L'idée maîtresse — *le « drag
start » tactile du `PointerSensor` (déclenché par le hold ~250 ms) EST le lift* — se
mappe proprement sur les événements de haut niveau de `@dnd-kit/react`, sans toucher
aux seuils d'activation ni écrire de `Sensor`.

## Approche retenue (à reprendre en #120)

Trois handlers sur `<DragDropProvider>`, aucun sensor custom :

1. **`onDragStart`** — c'est le **lift**. Discriminer la source via
   `operation.activatorEvent` : `PointerEvent.pointerType !== "mouse"` ⇒ tactile.
   - Tactile : ouvrir le menu contextuel ancré sous le doigt
     (`activatorEvent.clientX/clientY`), poser l'état « lifted », vibrer.
   - Souris : ne rien faire de spécial (desktop = clic droit pour le menu).
2. **`onDragMove`** — bascule lift → drag. Si geste de lift **et** déplacement
   `Math.hypot(operation.transform.x, y)` > seuil (≈8 px ici) : refermer le menu et
   marquer « basculé en drag » (ref de course). Une seule bascule par geste.
3. **`onDragEnd`** — décider :
   - drag réel (souris directe **ou** lift basculé) + index changé ⇒ persister le
     réordonnancement/déplacement ;
   - lift **relâché sur place** (pas de bascule) ⇒ **laisser le menu ouvert** pour
     la sélection.

Deux refs portent l'état de course (`liftGesture`, `movedAfterLift`) pour être lues
dans `onDragEnd` sans dépendre d'un re-render entre move et end.

### Réutilisations en prod (#120)

- **Menu** : réutiliser `useRowMenu` + `RowMenu` (`apps/web/src/components/`) plutôt
  que le menu local du spike. **Manque** : une ouverture **programmatique** (au lift)
  — aujourd'hui `useRowMenu` n'ouvre que sur clic droit / clavier ; il a déjà un
  `openFromElement` interne à exposer (ou un `openAt({x, y})`).
- **Réordonnancement** : ne PAS remocker — brancher sur `handleDragEnd` /
  `resolveFeedDragEnd` / lexorank existants (#111/#112, déjà testés). Le spike ne
  réordonne qu'une liste mock à titre visuel.
- **Sensors** : garder `PointerSensor` aux **seuils par défaut** + `preventActivation`
  restreint aux boutons, exactement comme `Sidebar.tsx`. Pas de contrainte custom
  nécessaire pour le PoC (voir « pistes » plus bas si l'ergonomie le réclame).

## Vérifié (émulation navigateur, Chrome DevTools)

- **Tactile** : hold → **LIFT + menu** ; doigt qui bouge → **bascule en drag, menu
  refermé** ; relâché sans bouger → **menu conservé**. (Pointer events synthétiques
  `pointerType:"touch"`.)
- **Desktop** : clic droit → menu (`Renommer…` / `Se désabonner`) ; drag souris →
  réordonne. Pas de lift-menu à la souris.
- `pnpm typecheck` + `biome check` verts. Console propre (hors warning PWA méta).

## Risques & limites identifiés

1. **Conflit avec le scroll du drawer (priorité #1).** Sur mobile, l'appui long
   immobilise le doigt 250 ms : pendant ce délai le scroll est gelé. Au-delà du seuil
   *avant* activation, le `PointerSensor` doit **rendre le geste au scroll** (et non
   armer le drag). À éprouver sur device réel (#120) : un doigt qui scrolle vite ne
   doit jamais déclencher de lift involontaire. Piste si nécessaire :
   `PointerActivationConstraints.Delay { value, tolerance }` importé de `@dnd-kit/dom`
   (⚠️ ajouter `@dnd-kit/dom` aux deps directes — aujourd'hui transitif).
2. **`contextmenu` natif tactile (à NE PAS oublier en #120).** Sur mobile, l'appui
   long déclenche aussi le **menu contextuel natif du navigateur** (~500 ms), qui
   collisionne avec le lift dnd-kit (~250 ms) : il rouvrirait notre menu à un autre
   ancrage et réinitialiserait l'état « lifted ». Le spike le neutralise en ignorant
   le `contextmenu` quand un geste de lift est en cours (`liftGesture.current`).
   À reconduire en prod, idéalement complété par `touch-action`/`user-select` pour
   couper la sélection de texte et le callout iOS au long-press.
3. **Réglage des seuils.** Délai d'activation (250 ms) et seuil post-lift (≈8 px) sont
   à calibrer au doigt sur device — trop court = lift accidentel au tap, trop long =
   geste poussif. Hors émulation, valeurs non confirmées.
3. **Retour haptique.** `navigator.vibrate(10)` pré-câblé au lift. Non garanti :
   ignoré sur iOS Safari, soumis à interaction utilisateur, parfois bridé par l'OS.
   À traiter comme amélioration best-effort, pas comme signal essentiel.
4. **Fidélité du harness de test.** Les pointer events synthétiques ne rejouent pas la
   projection d'index sortable de dnd-kit (le réordonnancement n'apparaît qu'au drag
   souris réel / device). ⇒ la **vérif tactile réelle reste indispensable** (HITL,
   c'est l'objet de #120). Le lift dispatché sur `document` ne déclenche pas
   `onDragMove` : écouter/relayer les moves au bon niveau (le PoC dispatch sur la
   ligne).
5. **A11y inchangée.** Le spike ne couvre pas le clavier (hors scope) : en prod, le
   menu reste ouvrable par `Shift+F10` / touche Menu et le réordonnancement par
   `KeyboardSensor`, déjà en place.

## Décision

Intégrer en #120 selon l'approche ci-dessus (3 handlers, réutilisation `useRowMenu` +
logique de rang existante), puis **valider sur un Android réel** : scroll vs lift,
calibrage des seuils, ressenti haptique. Supprimer ce prototype au nettoyage.
