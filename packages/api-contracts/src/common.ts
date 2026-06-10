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
