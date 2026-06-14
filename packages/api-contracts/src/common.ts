import { z } from "zod";

/**
 * Corps d'erreur JSON standard de l'API : `{ error: <code> }`. Toutes les
 * réponses non-2xx qui portent un corps suivent cette forme (le SPA en lit le
 * `code` via `apiFetch`).
 */
export const apiErrorSchema = z.object({ error: z.string() });
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;

/** Réponse de confirmation idempotente `{ ok: true }` (delete Folder/Feed). */
export const okResponseSchema = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof okResponseSchema>;

/**
 * Enum de thème, **source de vérité unique** partagée par `settings.theme` (D1),
 * l'API et le SPA (auparavant redéclaré à trois endroits). Côté SPA,
 * `theme.ts` ré-exporte `type ThemePreference = Theme`.
 */
export const themeSchema = z.enum(["light", "dark", "system"]);
export type Theme = z.infer<typeof themeSchema>;

/**
 * Curseur de pagination keyset des listes d'articles : la clé de tri
 * (`coalesce(published_at, fetched_at)`) et l'`id` du dernier article servi.
 */
export interface ArticleCursor {
  /** Clé de tri du dernier article servi : `coalesce(published_at, fetched_at)`. */
  sortKey: string;
  id: string;
}

/**
 * Encode/décode le curseur en **base64url** de `sortKey|id`. **Source de vérité
 * unique** du format : c'est le **contrat de parité** entre la pagination serveur
 * (`GET /api/articles`) et la pagination locale du réplica (`readUnreadPage`,
 * #72). Toute divergence ferait sauter ou boucler des articles à la jointure de
 * page, uniquement sur le chemin local — d'où la centralisation ici.
 */
export function encodeArticleCursor(sortKey: string, id: string): string {
  return toBase64Url(`${sortKey}|${id}`);
}

export function decodeArticleCursor(
  raw: string | undefined,
): ArticleCursor | null {
  if (!raw) return null;
  try {
    const decoded = fromBase64Url(raw);
    const sep = decoded.indexOf("|");
    if (sep === -1) return null;
    return { sortKey: decoded.slice(0, sep), id: decoded.slice(sep + 1) };
  } catch {
    return null;
  }
}

// `btoa`/`atob` sont des globals standards présents chez les deux consommateurs
// (Worker côté API, navigateur côté SPA) mais absents de la lib TS de ce package
// de contrats (ni DOM ni WebWorker) ; on y accède via `globalThis` typé pour ne
// pas tirer la lib DOM dans un package neutre.
const base64 = globalThis as unknown as {
  btoa(data: string): string;
  atob(data: string): string;
};

function toBase64Url(value: string): string {
  return base64
    .btoa(value)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return base64.atob(padded);
}
