/**
 * SPIKE JETABLE (#119) — geste long-press unifié « style iOS » (ADR 0019).
 *
 * Question dérisquée : sur mobile, un même appui doit ouvrir le **menu contextuel**
 * ET pouvoir déclencher un **drag** de réorganisation — collision frontale, car le
 * drag arme déjà le long-press ~250 ms du `PointerSensor`. Modèle retenu : l'appui
 * long **soulève** la ligne et présente le menu ; si le doigt **bouge** avant de
 * relâcher, l'interaction **bascule en drag** ; relâché sur place, le menu reste.
 *
 * Idée clé validée ici : le « drag start » du PointerSensor tactile (déclenché par
 * le hold 250 ms) EST le lift. On l'intercepte (`onDragStart`) pour ouvrir le menu
 * + vibrer ; tout déplacement ultérieur (`onDragMove`, `operation.transform`) annule
 * le menu et laisse le drag se poursuivre ; à la fin (`onDragEnd`), sans déplacement
 * on garde le menu ouvert pour la sélection.
 *
 * Données mockées, réordonnancement local visuel, AUCUNE mutation API. Pas câblé
 * dans la vraie `Sidebar`. À SUPPRIMER au nettoyage (#121 / clôture #120).
 * Verdict + risques : prototype.longpress.NOTES.md à côté.
 */
import {
  DragDropProvider,
  type DragEndEvent,
  type DragMoveEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
} from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import { createFileRoute } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export const Route = createFileRoute("/prototype/longpress")({
  component: SpikePage,
});

// --------------------------------------------------------------- Données mock
type MockFeed = { id: string; title: string; unread: boolean };

const INITIAL_FEEDS: MockFeed[] = [
  { id: "hn", title: "Hacker News", unread: true },
  { id: "csstricks", title: "CSS-Tricks", unread: false },
  { id: "smashing", title: "Smashing Magazine", unread: true },
  { id: "lemonde", title: "Le Monde", unread: false },
  { id: "reuters", title: "Reuters Top News", unread: true },
  { id: "alice", title: "Le blog d'Alice", unread: false },
  { id: "ih", title: "Indie Hackers", unread: false },
];

const FEED_GROUP = "spike-feeds";
const FEED_TYPE = "feed";

/** Seuil (px) de déplacement post-lift au-delà duquel on considère un drag (et non
 *  une simple sélection au menu). Indépendant du seuil d'activation du sensor. */
const MOVE_AFTER_LIFT_THRESHOLD = 8;

// --------------------------------------------------------------- Sensors
/**
 * On conserve les **seuils par défaut** du `PointerSensor` (souris : distance ~5px ;
 * tactile : long-press ~250 ms), exactement comme la `Sidebar` réelle. Le défaut
 * fournit déjà le « hold-to-lift » tactile dont on a besoin — aucune contrainte
 * d'activation custom requise pour le PoC (cf. NOTES pour l'ajustement #120).
 * `preventActivation` restreint l'armement aux non-boutons pour garder les entrées
 * de menu cliquables.
 */
const sensors = [
  PointerSensor.configure({
    preventActivation: (event) =>
      event.target instanceof Element &&
      event.target.closest("button") !== null,
  }),
  KeyboardSensor,
];

// --------------------------------------------------------------- Menu (jetable)
type MenuState = { x: number; y: number; feedId: string; title: string };

/** Marge minimale entre le popover et le bord du viewport (clamp anti-débordement). */
const VIEWPORT_MARGIN = 8;

/**
 * Menu contextuel minimal du spike. En prod (#120) on réutilise `useRowMenu` +
 * `RowMenu` (apps/web/src/components/), en leur ajoutant une ouverture
 * **programmatique** au lift (aujourd'hui pilotée seulement par clic droit/clavier).
 * Ici on reprend juste le clamp viewport de `RowMenu` pour qu'un lift en bas/à
 * droite d'un petit écran ne pousse pas le menu hors champ (surface de test mobile).
 */
function SpikeMenu({
  state,
  onClose,
}: {
  state: MenuState | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState({ x: state?.x ?? 0, y: state?.y ?? 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!state || !el) return;
    const { width, height } = el.getBoundingClientRect();
    setCoords({
      x: Math.max(
        VIEWPORT_MARGIN,
        Math.min(state.x, window.innerWidth - width - VIEWPORT_MARGIN),
      ),
      y: Math.max(
        VIEWPORT_MARGIN,
        Math.min(state.y, window.innerHeight - height - VIEWPORT_MARGIN),
      ),
    });
  }, [state]);

  if (!state) return null;
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={state.title}
      className="fixed z-50 min-w-52 rounded-card border border-border bg-surface p-1 shadow-pop"
      style={{ left: coords.x, top: coords.y }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <p className="px-3 pt-1.5 pb-1 font-semibold text-[0.65rem] text-muted uppercase tracking-wide">
        {state.title}
      </p>
      {["Renommer…", "Se désabonner"].map((label) => (
        <button
          key={label}
          type="button"
          role="menuitem"
          onClick={onClose}
          className="flex w-full items-center rounded-card px-3 py-2 text-left text-sm text-text transition-colors hover:bg-surface-2"
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// --------------------------------------------------------------- Ligne sortable
function Row({
  feed,
  index,
  lifted,
  onContextMenu,
}: {
  feed: MockFeed;
  index: number;
  /** Soulevée par le geste long-press (menu présenté). */
  lifted: boolean;
  onContextMenu: (e: React.MouseEvent, feed: MockFeed) => void;
}) {
  const { ref, isDragSource } = useSortable({
    id: feed.id,
    index,
    group: FEED_GROUP,
    type: FEED_TYPE,
    accept: FEED_TYPE,
  });

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: spike jetable — clic droit de commodité, accès clavier hors scope du PoC.
    <div
      ref={ref}
      data-feed-row={feed.id}
      onContextMenu={(e) => onContextMenu(e, feed)}
      className={[
        "flex min-h-11 w-full select-none items-center gap-2 rounded-card px-3 text-left text-sm transition-transform",
        lifted ? "scale-[1.03] bg-surface-2 shadow-pop" : "hover:bg-surface-2",
        isDragSource ? "opacity-40" : "",
      ].join(" ")}
    >
      <span className={`flex-1 truncate ${feed.unread ? "font-medium" : ""}`}>
        {feed.title}
      </span>
      {feed.unread && (
        <span
          aria-hidden
          className="size-1.5 shrink-0 rounded-full bg-accent"
        />
      )}
    </div>
  );
}

// --------------------------------------------------------------- Page
function SpikePage() {
  const [feeds, setFeeds] = useState(INITIAL_FEEDS);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [liftedId, setLiftedId] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);

  // Refs de course du geste (lus dans `onDragEnd` sans dépendre d'un re-render
  // entre move et end) :
  // - `liftGesture` : ce drag a démarré par un lift tactile (≠ drag souris direct).
  // - `movedAfterLift` : le doigt a dépassé le seuil post-lift → bascule en drag.
  const liftGesture = useRef(false);
  const movedAfterLift = useRef(false);

  const pushLog = useCallback((line: string) => {
    setLog((prev) => [line, ...prev].slice(0, 8));
  }, []);

  const closeMenu = useCallback(() => {
    setMenu(null);
    setLiftedId(null);
  }, []);

  // Fermeture du menu (calquée sur `useRowMenu`) : Échap, clic extérieur (le
  // `SpikeMenu` stoppe son propre `pointerdown`), scroll de n'importe quel
  // conteneur (capture) et redimensionnement. Sans ça le menu resterait bloqué
  // ouvert après un relâché-sur-place tactile.
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };
    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("resize", closeMenu);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("resize", closeMenu);
    };
  }, [menu, closeMenu]);

  // Clic droit (desktop) : chemin menu inchangé, sans lift ni drag. On ignore le
  // `contextmenu` NATIF déclenché par l'appui long tactile (geste de lift en
  // cours) — sinon il rouvrirait le menu à un autre ancrage et réinitialiserait
  // `liftedId`, en collision avec le lift dnd-kit.
  const onContextMenu = useCallback(
    (e: React.MouseEvent, feed: MockFeed) => {
      e.preventDefault();
      if (liftGesture.current) return;
      setMenu({
        x: e.clientX,
        y: e.clientY,
        feedId: feed.id,
        title: feed.title,
      });
      setLiftedId(null);
      pushLog(`desktop · clic droit → menu « ${feed.title} »`);
    },
    [pushLog],
  );

  const onDragStart = useCallback(
    (event: DragStartEvent) => {
      movedAfterLift.current = false;
      const source = event.operation.source;
      const activator = event.operation.activatorEvent;
      // Souris : drag immédiat classique, pas de lift-menu (desktop = clic droit).
      const isTouch =
        activator instanceof PointerEvent && activator.pointerType !== "mouse";
      liftGesture.current = isTouch && Boolean(source);
      if (!isTouch || !source) {
        pushLog("souris · drag direct (pas de menu au lift)");
        return;
      }
      const feed = feeds.find((f) => f.id === String(source.id));
      if (!feed) return;
      // LIFT : on présente le menu ancré sous le doigt + retour haptique.
      navigator.vibrate?.(10);
      setLiftedId(feed.id);
      setMenu({
        x: activator.clientX,
        y: activator.clientY + 12,
        feedId: feed.id,
        title: feed.title,
      });
      pushLog(`tactile · LIFT → menu « ${feed.title} » (vibrate 10ms)`);
    },
    [feeds, pushLog],
  );

  const onDragMove = useCallback(
    (event: DragMoveEvent) => {
      // Seul un geste de lift tactile peut « basculer » : un drag souris est déjà
      // un drag. On ne bascule qu'une fois.
      if (!liftGesture.current || movedAfterLift.current) return;
      const { x, y } = event.operation.transform;
      if (Math.hypot(x, y) <= MOVE_AFTER_LIFT_THRESHOLD) return;
      // Le doigt a franchi le seuil → bascule en drag, le menu s'efface.
      movedAfterLift.current = true;
      setMenu(null);
      pushLog("tactile · MOVE → bascule en drag (menu refermé)");
    },
    [pushLog],
  );

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { source, canceled } = event.operation;
      // Réordonne quand l'item a effectivement changé d'index ET que le geste est
      // un drag : soit un drag souris direct (`!liftGesture`), soit un lift tactile
      // qui a basculé (`movedAfterLift`). Un lift relâché sur place ne réordonne pas.
      const isDrag = !liftGesture.current || movedAfterLift.current;
      const reordered =
        isDrag &&
        !canceled &&
        source &&
        typeof source.index === "number" &&
        typeof source.initialIndex === "number" &&
        source.index !== source.initialIndex;
      if (reordered) {
        setFeeds((prev) => {
          const next = [...prev];
          const [moved] = next.splice(source.initialIndex, 1);
          next.splice(source.index, 0, moved);
          return next;
        });
        pushLog(`DROP → réordonné ${source.initialIndex} → ${source.index}`);
        setLiftedId(null);
      } else if (liftGesture.current && !movedAfterLift.current) {
        // Lift relâché sur place : on LAISSE le menu ouvert ET la ligne soulevée
        // (on ne touche pas `liftedId`) pour qu'elle reste présentée à la sélection.
        pushLog("tactile · relâché sur place → menu conservé");
      } else {
        setLiftedId(null);
      }
      // Geste terminé : `liftGesture` ne doit refléter qu'un lift EN COURS (sinon
      // le garde `contextmenu` bloquerait à tort le clic droit desktop suivant).
      liftGesture.current = false;
    },
    [pushLog],
  );

  const orderLabel = useMemo(() => feeds.map((f) => f.id).join(" · "), [feeds]);

  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 bg-bg p-6 text-text">
      <header className="space-y-1">
        <p className="font-semibold text-accent text-xs uppercase tracking-wide">
          Spike #119 — jetable
        </p>
        <h1 className="font-semibold text-xl">Geste long-press unifié</h1>
        <p className="text-muted text-sm">
          Émule un appareil tactile (DevTools → Toggle device toolbar). Appui
          long sur une ligne → elle se soulève + menu. Garde le doigt et bouge →
          ça draggue (réordonne). Relâche sans bouger → le menu reste. Sur
          desktop (souris) : clic droit = menu, glisser = drag.
        </p>
      </header>

      <div className="grid gap-6 md:grid-cols-[1fr_18rem]">
        <DragDropProvider
          sensors={sensors}
          onDragStart={onDragStart}
          onDragMove={onDragMove}
          onDragEnd={onDragEnd}
        >
          <nav
            aria-label="Flux (spike)"
            className="space-y-1 rounded-card border border-border bg-surface p-2"
          >
            {feeds.map((feed, index) => (
              <Row
                key={feed.id}
                feed={feed}
                index={index}
                lifted={liftedId === feed.id}
                onContextMenu={onContextMenu}
              />
            ))}
          </nav>

          <DragOverlay>
            {(source) => {
              const feed = feeds.find((f) => f.id === String(source.id));
              if (!feed) return null;
              return (
                <div className="flex min-h-11 items-center gap-2 rounded-card border border-border bg-surface px-3 text-sm shadow-pop">
                  <span className="truncate">{feed.title}</span>
                </div>
              );
            }}
          </DragOverlay>
        </DragDropProvider>

        <aside className="space-y-3 text-sm">
          <div>
            <p className="font-medium text-muted text-xs uppercase tracking-wide">
              Ordre courant
            </p>
            <p className="break-words text-muted text-xs">{orderLabel}</p>
          </div>
          <div>
            <p className="font-medium text-muted text-xs uppercase tracking-wide">
              Journal du geste
            </p>
            <ul className="mt-1 space-y-1 text-muted text-xs">
              {log.length === 0 ? (
                <li className="italic">— aucun geste —</li>
              ) : (
                log.map((line, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: journal éphémère, spike.
                  <li key={i} className="font-mono">
                    {line}
                  </li>
                ))
              )}
            </ul>
          </div>
        </aside>
      </div>

      <SpikeMenu state={menu} onClose={closeMenu} />
    </div>
  );
}
