import type { Mock } from "vitest";

/**
 * Harness de mock du transport `apiFetch` par **table de routes**, en remplacement
 * des chaînes `mockResolvedValueOnce` fragiles : les vues articles enchaînent 2-3
 * GET concurrents (liste + compteurs + feeds/folders), dont l'ordre n'est pas
 * déterministe. Une table « METHOD /path » est robuste à cet ordre.
 *
 * Le `vi.mock("../lib/api")` reste **dans chaque fichier de test** (hoisting de
 * Vitest, convention du repo cf. `AddFeedDialog.test.tsx`) ; on ne fournit ici
 * que le câblage de l'implémentation du mock déjà créé.
 */

/** Contexte passé à un handler dynamique. */
export interface ApiHandlerContext {
  /** Paramètres extraits du motif (`:param`), valeurs telles quelles dans l'URL. */
  params: Record<string, string>;
  /** Corps de la requête, parsé en JSON si présent (sinon `undefined`). */
  body: unknown;
  /** Chemin complet appelé (sans le préfixe `/api`), query-string incluse. */
  url: string;
}

/**
 * Réponse d'une route : valeur statique renvoyée telle quelle, ou fonction
 * calculant la réponse à partir du contexte (params/body/url). La fonction peut
 * être asynchrone.
 */
export type ApiHandler<T = unknown> =
  | T
  | ((ctx: ApiHandlerContext) => T | Promise<T>);

/**
 * Table de routes : clé `"METHOD /path"` (ex. `"GET /articles"`,
 * `"PATCH /articles/:id"`). Le motif `:param` capture un segment.
 */
export type ApiRoutes = Record<string, ApiHandler>;

/** Découpe une clé `"GET /path"` en méthode normalisée + chemin (sans query). */
function parseRouteKey(key: string): { method: string; segments: string[] } {
  const [method, path] = key.split(/\s+/, 2);
  if (!method || !path) {
    throw new Error(
      `Clé de route invalide (attendu "METHOD /path") : "${key}"`,
    );
  }
  return { method: method.toUpperCase(), segments: splitPath(path) };
}

/** Segments non vides d'un chemin (ignore les `/` de tête/fin). */
function splitPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/**
 * Tente d'apparier un motif (`["articles", ":id"]`) à des segments concrets.
 * Renvoie les params capturés, ou `null` si le motif ne correspond pas.
 */
function matchSegments(
  pattern: string[],
  actual: string[],
): Record<string, string> | null {
  if (pattern.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const seg = pattern[i];
    const value = actual[i];
    if (seg === undefined || value === undefined) return null;
    if (seg.startsWith(":")) {
      params[seg.slice(1)] = decodeURIComponent(value);
    } else if (seg !== value) {
      return null;
    }
  }
  return params;
}

/**
 * Câble un `apiFetch` déjà mocké (`vi.fn()`) sur une table de routes. Toute
 * requête dont la méthode+chemin n'est appariée par aucune entrée est **rejetée
 * explicitement** : un appel inattendu fait échouer le test au lieu de renvoyer
 * `undefined` silencieusement.
 *
 * Le `path` passé à `apiFetch` est celui d'après le préfixe `/api` (cf. `api.ts`),
 * et peut porter une query-string — seul le chemin sert à l'appariement.
 */
export function stubApi(mockedFetch: Mock, routes: ApiRoutes): void {
  const entries = Object.entries(routes).map(([key, handler]) => ({
    ...parseRouteKey(key),
    handler,
  }));

  mockedFetch.mockImplementation((path: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const actual = splitPath(path.split("?")[0] ?? path);

    for (const entry of entries) {
      if (entry.method !== method) continue;
      const params = matchSegments(entry.segments, actual);
      if (!params) continue;

      if (typeof entry.handler !== "function") {
        return Promise.resolve(entry.handler);
      }
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return Promise.resolve(
        (entry.handler as (ctx: ApiHandlerContext) => unknown)({
          params,
          body,
          url: path,
        }),
      );
    }

    return Promise.reject(
      new Error(`Aucune route mockée pour ${method} ${path}`),
    );
  });
}
