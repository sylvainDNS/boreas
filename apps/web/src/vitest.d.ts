// Charge l'augmentation des matchers jest-dom sur l'`Assertion` de Vitest
// (`toBeInTheDocument`, `toHaveTextContent`, …) pour le typecheck — le setup de
// test, hors de `include`, ne suffit pas à `tsc`.
import "@testing-library/jest-dom/vitest";
