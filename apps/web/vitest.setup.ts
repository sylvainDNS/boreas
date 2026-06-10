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

// Démonte l'arbre rendu entre chaque test (isolation du DOM).
afterEach(() => {
  cleanup();
});
