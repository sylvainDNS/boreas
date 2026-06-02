import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURES_DIR = join(import.meta.dirname, "../../fixtures");

/**
 * Charge et parse un fichier JSON de fixture.
 * Le chemin est relatif au dossier `packages/shared/fixtures/`.
 *
 * Utilisation :
 *   const item = loadFixture<ArticleItem>("article-identity/with-guid.json");
 */
export function loadFixture<T>(relativePath: string): T {
  const fullPath = join(FIXTURES_DIR, relativePath);
  return JSON.parse(readFileSync(fullPath, "utf-8")) as T;
}
