import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

/**
 * Ligne unique de configuration globale (singleton, id toujours 1).
 * Contrainte CHECK définie dans la migration SQL (0000_init.sql).
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
  ],
);

// Tables à venir (feeds, articles, folders, auth_tokens) — ajoutées au fil des issues.
