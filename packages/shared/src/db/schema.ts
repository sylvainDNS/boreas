import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

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

/**
 * Jetons magic link à usage unique (ADR 0005). On ne stocke que l'empreinte
 * du jeton (jamais le clair) ; `used` + `expires_at` garantissent l'usage
 * unique et l'expiration côté serveur. Les sessions, elles, sont stateless
 * (cookie signé) et n'ont pas de table.
 */
export const authTokens = sqliteTable("auth_tokens", {
  token_hash: text("token_hash").primaryKey(),
  /** Expiration (epoch secondes). */
  expires_at: integer("expires_at").notNull(),
  used: integer("used", { mode: "boolean" }).notNull().default(false),
  created_at: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
});

/**
 * Feed : source distante RSS/Atom identifiée par son URL de flux directe
 * (CONTEXT.md). Un abonnement = une ligne ; l'unicité de `url` refuse les
 * doublons d'abonnement. Les colonnes de polling (etag, last_modified,
 * next_check_at) et `folder_id` seront ajoutées par #10/#13 (expand-only,
 * ADR 0011).
 */
export const feeds = sqliteTable("feeds", {
  /** UUID applicatif (crypto.randomUUID), stable et indépendant de l'ordre d'insertion. */
  id: text("id").primaryKey(),
  /** URL du flux directe ; unique pour dédupliquer les abonnements. */
  url: text("url").notNull().unique(),
  /** Titre du flux tel que fourni par la source (nullable). */
  title: text("title"),
  created_at: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
});

/**
 * Article : unité de contenu d'un Feed (CONTEXT.md). L'identité est la clé
 * `(feed_id, article_key)` calculée par `articleKey()` (ADR 0001) ;
 * l'index unique correspondant garantit la déduplication par flux.
 *
 * D1 porte les métadonnées + un résumé texte fourni par le flux ; le HTML plein
 * extrait+sanitizé (#7) vit en R2, référencé par `content_key`. L'état `saved`
 * arrive en #9 ; `read` bascule à l'ouverture de l'article (#7) et via le toggle
 * manuel (#8).
 */
export const articles = sqliteTable(
  "articles",
  {
    /** UUID applicatif. */
    id: text("id").primaryKey(),
    feed_id: text("feed_id")
      .notNull()
      .references(() => feeds.id),
    /** Clé de déduplication stable (ADR 0001) : guid → link → hash. */
    article_key: text("article_key").notNull(),
    title: text("title"),
    link: text("link"),
    /** Résumé texte (balises retirées) fourni par le flux. */
    summary: text("summary"),
    /**
     * Clé de l'objet R2 du HTML plein extrait+sanitizé (`articles/{id}.html`,
     * ADR 0003/0004/0007), ou null si l'extraction n'a rien produit. Le contenu
     * lui-même vit en R2, pas en D1 (#7).
     */
    content_key: text("content_key"),
    /** Date de publication ISO 8601 UTC, ou null si absente/illisible. */
    published_at: text("published_at"),
    /** Enclosures (média joints) sérialisées en JSON, ou null. */
    enclosures: text("enclosures"),
    /** État Read (#8) ; les articles sont backfillés en non-lu. */
    read: integer("read", { mode: "boolean" }).notNull().default(false),
    /** Horodatage d'ingestion ISO UTC — clé de tri de la pagination keyset. */
    fetched_at: text("fetched_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
    created_at: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
  },
  (table) => [
    // Déduplication par flux (ADR 0001) : même clé dans le même feed = même Article.
    uniqueIndex("articles_feed_key").on(table.feed_id, table.article_key),
    // Pagination keyset de « Tous les non-lus » : (read, fetched_at desc, id).
    index("articles_unread_keyset").on(table.read, table.fetched_at, table.id),
  ],
);

// Tables à venir (folders) — ajoutées au fil des issues.
