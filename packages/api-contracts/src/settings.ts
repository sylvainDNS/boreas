import { z } from "zod";
import { themeSchema } from "./common";

/**
 * PATCH partiel des réglages (#18) : au moins un champ requis (`.refine`). Les
 * bornes sont larges côté serveur (1 min – 24 h, 1 j – 10 ans) ; les presets de
 * l'UI sont une contrainte d'ergonomie, pas d'API.
 */
export const settingsPatchSchema = z
  .object({
    refreshIntervalMin: z.number().int().min(1).max(1440).optional(),
    purgeWindowDays: z.number().int().min(1).max(3650).optional(),
    theme: themeSchema.optional(),
  })
  .refine(
    (d) =>
      d.refreshIntervalMin !== undefined ||
      d.purgeWindowDays !== undefined ||
      d.theme !== undefined,
    { message: "no_field" },
  );
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

/** Projection camelCase de la ligne `settings` (réponses GET et PATCH). */
export const settingsResponseSchema = z.object({
  refreshIntervalMin: z.number(),
  purgeWindowDays: z.number(),
  theme: themeSchema,
});
export type SettingsResponse = z.infer<typeof settingsResponseSchema>;
