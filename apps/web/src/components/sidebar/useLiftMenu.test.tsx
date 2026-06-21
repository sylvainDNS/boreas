import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOVE_AFTER_LIFT_THRESHOLD } from "./sidebar-model";
import { useLiftMenu } from "./useLiftMenu";

// `useDragDropMonitor` fire dans un `DragDropProvider` réel : on le mocke pour
// capturer les handlers et les piloter par des `event.operation` synthétiques —
// les vrais pointer events du sensor dnd-kit ne sont pas rejouables en jsdom (cf.
// NOTES du spike #119). Le reste du geste relève du HITL Android.
let captured: {
  onDragStart?: (e: unknown) => void;
  onDragMove?: (e: unknown) => void;
  onDragEnd?: (e: unknown) => void;
} = {};

vi.mock("@dnd-kit/react", () => ({
  useDragDropMonitor: (handlers: typeof captured) => {
    captured = handlers;
  },
}));

/** Fabrique un `event.operation` minimal pour piloter les handlers capturés. */
function op(args: {
  id?: string;
  pointerType?: string;
  clientX?: number;
  clientY?: number;
  transform?: { x: number; y: number };
}) {
  const activatorEvent =
    args.pointerType === undefined
      ? null
      : new PointerEvent("pointerdown", {
          pointerType: args.pointerType,
          clientX: args.clientX ?? 0,
          clientY: args.clientY ?? 0,
        });
  return {
    operation: {
      source: args.id === undefined ? null : { id: args.id },
      activatorEvent,
      transform: args.transform ?? { x: 0, y: 0 },
    },
  };
}

function setup(sourceId = "feed-1") {
  const openAt = vi.fn();
  const close = vi.fn();
  const view = renderHook(() => useLiftMenu({ sourceId, openAt, close }));
  // Les handlers déclenchent des setstates (liftActive) : on les invoque dans
  // `act` pour que `view.result.current` reflète l'état.
  const start = (a: Parameters<typeof op>[0]) =>
    act(() => captured.onDragStart?.(op(a)));
  const move = (a: Parameters<typeof op>[0]) =>
    act(() => captured.onDragMove?.(op(a)));
  const end = (a: Parameters<typeof op>[0]) =>
    act(() => captured.onDragEnd?.(op(a)));
  return { openAt, close, view, start, move, end };
}

beforeEach(() => {
  captured = {};
  Object.defineProperty(navigator, "vibrate", {
    value: vi.fn(),
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useLiftMenu", () => {
  it("lift tactile : ouvre le menu sous le doigt + vibre + liftActive", () => {
    const { openAt, view, start } = setup("feed-1");

    start({ id: "feed-1", pointerType: "touch", clientX: 40, clientY: 100 });

    expect(openAt).toHaveBeenCalledWith(40, 112); // clientY + 12
    expect(navigator.vibrate).toHaveBeenCalledWith(10);
    expect(view.result.current.liftActive).toBe(true);
  });

  it("souris : pas de menu au lift (desktop = clic droit), liftActive reste faux", () => {
    const { openAt, view, start } = setup("feed-1");

    start({ id: "feed-1", pointerType: "mouse", clientX: 40, clientY: 100 });

    expect(openAt).not.toHaveBeenCalled();
    expect(view.result.current.liftActive).toBe(false);
  });

  it("ignore un drag dont la source n'est pas la sienne", () => {
    const { openAt, view, start } = setup("feed-1");

    start({ id: "autre", pointerType: "touch", clientX: 10, clientY: 10 });

    expect(openAt).not.toHaveBeenCalled();
    expect(view.result.current.liftActive).toBe(false);
  });

  it("move au-delà du seuil après lift : referme le menu (bascule en drag)", () => {
    const { close, start, move } = setup("feed-1");

    start({ id: "feed-1", pointerType: "touch", clientX: 0, clientY: 0 });
    move({
      id: "feed-1",
      transform: { x: MOVE_AFTER_LIFT_THRESHOLD + 1, y: 0 },
    });

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("move sous le seuil : ne referme pas (relâché sur place conserve le menu)", () => {
    const { close, start, move } = setup("feed-1");

    start({ id: "feed-1", pointerType: "touch", clientX: 0, clientY: 0 });
    move({ id: "feed-1", transform: { x: MOVE_AFTER_LIFT_THRESHOLD, y: 0 } });

    expect(close).not.toHaveBeenCalled();
  });

  it("ne bascule qu'une fois même sur plusieurs moves", () => {
    const { close, start, move } = setup("feed-1");

    start({ id: "feed-1", pointerType: "touch", clientX: 0, clientY: 0 });
    move({ id: "feed-1", transform: { x: 20, y: 0 } });
    move({ id: "feed-1", transform: { x: 40, y: 0 } });

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("end réinitialise liftActive", () => {
    const { view, start, end } = setup("feed-1");

    start({ id: "feed-1", pointerType: "touch", clientX: 0, clientY: 0 });
    expect(view.result.current.liftActive).toBe(true);

    end({ id: "feed-1" });
    expect(view.result.current.liftActive).toBe(false);
  });

  it("souris puis move ne referme pas (pas de lift à désarmer)", () => {
    const { close, start, move } = setup("feed-1");

    start({ id: "feed-1", pointerType: "mouse", clientX: 0, clientY: 0 });
    move({ id: "feed-1", transform: { x: 50, y: 0 } });

    expect(close).not.toHaveBeenCalled();
  });
});
