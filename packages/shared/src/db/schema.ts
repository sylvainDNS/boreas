import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Ligne unique de configuration globale (singleton, id toujours 1).
 * Les contraintes CHECK (singleton id = 1, thème valide) sont générées par drizzle
 * depuis les appels `check()` ci-dessous et matérialisées dans la migration DDL.
 */
export const settings = sqliteTable(
  "settings",
  {
    id: integer("id").primaryKey(),
    /** Adresse e-mail autorisée pour le magic link. */
    allowed_email: text("allowed_email").notNull(),
    /** Intervalle de rafraîchissement des feeds (minutes). */
    refresh_interval_min: integer("refresh_interval_min").notNull().default(30),
    /** Fenêtre de rétention des articles lus non-saved (jours). */
    purge_window_days: integer("purge_window_days").notNull().default(60),
    /** Thème de l'interface. */
    theme: text("theme", { enum: ["light", "dark", "system"] })
      .notNull()
      .default("system"),
    created_at: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
  },
  (table) => [
    // Garantit que la table ne contient jamais plus d'une ligne.
    check("settings_single_row", sql`${table.id} = 1`),
    // Borne les valeurs de thème au niveau base (redondant avec l'enum TS, mais défensif).
    check(
      "settings_theme_valid",
      sql`${table.theme} in ('light', 'dark', 'system')`,
    ),
  ],
);

// Tables à venir (feeds, articles, folders, auth_tokens) — ajoutées au fil des issues.
