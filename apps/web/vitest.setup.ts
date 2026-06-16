import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom ne fournit pas `IntersectionObserver` ; `ArticleListView` l'instancie
// pour la sentinelle de scroll infini. Stub global no-op : il suffit que le
// constructeur et `observe`/`disconnect` existent (les tests ne déclenchent pas
// d'intersection).
class IntersectionObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}
globalThis.IntersectionObserver =
  IntersectionObserverStub as unknown as typeof IntersectionObserver;

// jsdom ne fournit pas `ResizeObserver` ; `@dnd-kit/dom` l'instancie au
// chargement du module (drag-n-drop des Feeds). Même stub no-op : les tests
// montent les composants sans simuler de redimensionnement.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver =
  ResizeObserverStub as unknown as typeof ResizeObserver;

// jsdom n'implémente pas `window.scrollTo` (il logue « Not implemented:
// Window's scrollTo() method » via sa console virtuelle). TanStack Router
// l'appelle pour la restauration de scroll à chaque montage de `RouterProvider`
// (cf. `renderWithApp`), polluant la sortie des tests d'un warning par montage.
// Stub no-op : les tests n'assertent jamais sur la position de scroll.
window.scrollTo = (() => {}) as typeof window.scrollTo;

// Démonte l'arbre rendu entre chaque test (isolation du DOM).
afterEach(() => {
  cleanup();
});
