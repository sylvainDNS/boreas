import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURES_DIR = join(import.meta.dirname, "../../fixtures");

/** Charge une fixture (HTML/texte) telle quelle. */
export function loadFixture(relativePath: string): string {
  return readFileSync(join(FIXTURES_DIR, relativePath), "utf-8");
}
