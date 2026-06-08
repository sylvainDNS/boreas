import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Démonte l'arbre rendu entre chaque test (isolation du DOM).
afterEach(() => {
  cleanup();
});
