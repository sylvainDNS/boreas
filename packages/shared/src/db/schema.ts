import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { nowEpochMs } from "../timestamp";

/**
 * Curseur de delta sync (#69, ADR 0018) : horodatage de la dernière **mutation
 * de domaine** d'une ligne, en **epoch-ms** (entier), distinct des autres
 * timestamps du repo qui sont du texte ISO. Posé à la création et bumpé à chaque
 * écriture de domaine, jamais par les écritures de santé/polling d'un Feed
 * (etag, last_check_at… : sinon le delta re-pousserait le Feed à chaque poll).
 * `$defaultFn` pose la valeur côté code à l'INSERT : SQLite refuse un défaut
 * non-constant (`unixepoch()`) en ADD COLUMN NOT NULL, donc on ne s'appuie pas
 * sur un défaut SQL applicatif.
 */
const updatedAtColumn = () =>
  integer("updated_at")
    .notNull()
    .$defaultFn(() => nowEpochMs());

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
 * last_check_at, next_check_at) pilotent l'ingestion Cron+Queues (#10) ;
 * les colonnes de santé (consecutive_failures, last_error, last_error_at)
 * pilotent le backoff et le badge « en erreur » (#11) ;
 * `folder_id` rattache le Feed à un Folder (≤ 1, nullable) — assignation #13.
 */
export const feeds = sqliteTable("feeds", {
  /** UUID applicatif (crypto.randomUUID), stable et indépendant de l'ordre d'insertion. */
  id: text("id").primaryKey(),
  /** URL du flux directe ; unique pour dédupliquer les abonnements. */
  url: text("url").notNull().unique(),
  /** Titre du flux tel que fourni par la source (nullable). */
  title: text("title"),
  /** ETag du dernier 200, rejoué en `If-None-Match` au prochain conditional GET (#10). */
  etag: text("etag"),
  /** Last-Modified du dernier 200, rejoué en `If-Modified-Since` (#10). */
  last_modified: text("last_modified"),
  /** Dernier passage d'ingestion (succès ou échec), ISO 8601 UTC (#10). */
  last_check_at: text("last_check_at"),
  /** Échéance de prochaine vérif, étalée par jitter (ADR 0002) ; null = dû immédiatement (#10). */
  next_check_at: text("next_check_at"),
  /**
   * Nombre d'échecs d'ingestion consécutifs (#11). Pilote le backoff
   * exponentiel (×2 par échec, plafonné 24 h) et l'état « en erreur »
   * (≥ 3 = `ERROR_THRESHOLD`). Remis à 0 au premier succès.
   */
  consecutive_failures: integer("consecutive_failures").notNull().default(0),
  /** Code de la dernière erreur d'ingestion (`http_404`, `timeout`…), ou null si sain (#11). */
  last_error: text("last_error"),
  /** Horodatage ISO 8601 UTC du dernier échec, ou null si sain (#11). */
  last_error_at: text("last_error_at"),
  /**
   * Folder de rattachement (≤ 1 par Feed, nullable = non classé) (#13). FK en
   * `ON DELETE no action` (défaut drizzle) : supprimer un Folder exige de
   * désassigner ses Feeds d'abord (cf. `DELETE /folders/:id`). Référence
   * paresseuse (`() => folders.id`) car `folders` est déclaré plus bas.
   */
  folder_id: text("folder_id").references(() => folders.id),
  /**
   * Désabonnement (#14, ADR 0010) : `null` = Feed actif ; horodatage ISO 8601
   * UTC = Feed désabonné (masqué). Marqueur unique qui sort le Feed de la
   * sélection Cron, de la sidebar et des vues non-lus/compteurs, tout en gardant
   * la ligne pour préserver le contexte de ses Articles Saved (conservés). Remis
   * à `null` au ré-abonnement (réactivation). À ne pas confondre avec le statut
   * santé `ok`/`error`, lui dérivé de `consecutive_failures`.
   */
  unsubscribed_at: text("unsubscribed_at"),
  created_at: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
  /** Curseur de delta sync (#69) ; bumpé par les mutations de domaine, pas le polling. */
  updated_at: updatedAtColumn(),
});

/**
 * Article : unité de contenu d'un Feed (CONTEXT.md). L'identité est la clé
 * `(feed_id, article_key)` calculée par `articleKey()` (ADR 0001) ;
 * l'index unique correspondant garantit la déduplication par flux.
 *
 * D1 porte les métadonnées + un résumé texte fourni par le flux ; le HTML plein
 * extrait+sanitizé (#7) vit en R2, référencé par `content_key`. `read` bascule à
 * l'ouverture de l'article (#7) et via le toggle manuel (#8) ; `saved` conserve
 * l'Article hors flux et le soustrait à la purge (#9, rétention vérifiée par #15).
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
    /** État Saved (#9) : conserve l'Article hors flux, jamais purgé (#15). */
    saved: integer("saved", { mode: "boolean" }).notNull().default(false),
    /** Horodatage d'ingestion ISO UTC — clé de tri de la pagination keyset. */
    fetched_at: text("fetched_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
    created_at: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
    /** Curseur de delta sync (#69) : bumpé par Read/Saved/mark-all-read, posé à l'ingestion. */
    updated_at: updatedAtColumn(),
  },
  (table) => [
    // Déduplication par flux (ADR 0001) : même clé dans le même feed = même Article.
    uniqueIndex("articles_feed_key").on(table.feed_id, table.article_key),
    // Pagination keyset de « Tous les non-lus » : (read, fetched_at desc, id).
    index("articles_unread_keyset").on(table.read, table.fetched_at, table.id),
  ],
);

/**
 * Folder : regroupement de Feeds (jamais d'Articles), hiérarchie plate, un seul
 * niveau (CONTEXT.md). Un Feed appartient à au plus un Folder via `feeds.folder_id` ;
 * ouvrir un Folder agrège les Articles de tous ses Feeds (#13). Pas de contrainte
 * d'unicité sur `name` : deux Folders peuvent porter le même nom.
 */
export const folders = sqliteTable("folders", {
  /** UUID applicatif (crypto.randomUUID). */
  id: text("id").primaryKey(),
  /** Nom affiché du Folder (libre, non vide côté API). */
  name: text("name").notNull(),
  created_at: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
  /** Curseur de delta sync (#69) : bumpé par création/renommage. */
  updated_at: updatedAtColumn(),
});

/**
 * Tombstones (#69, ADR 0018) : trace des suppressions destructives, lue par le
 * delta sync (`GET /api/sync`, #72 à venir) pour propager au réplica local
 * l'éviction d'une entité disparue. Alimentée par la **purge** de rétention et
 * les **Delete** (Feed/Folder) — qui faisaient jusqu'ici un hard-delete sans
 * trace. Le **désabonnement** (#14) n'écrit PAS de tombstone Feed (la ligne
 * Feed subsiste et « descend » via son `updated_at`), mais ses articles purgés
 * suivent le chemin de suppression tracé comme la purge.
 *
 * PK composite `(entity_type, entity_id)` : une re-suppression de la même entité
 * est idempotente (upsert sur conflit), sans accumuler de doublons.
 */
export const tombstones = sqliteTable(
  "tombstones",
  {
    /** Type d'entité supprimée. Borné à {article, feed, folder}. */
    entity_type: text("entity_type", {
      enum: ["article", "feed", "folder"],
    }).notNull(),
    /** UUID de l'entité supprimée. */
    entity_id: text("entity_id").notNull(),
    /** Horodatage de suppression en epoch-ms (entier, même base que `updated_at`). */
    deleted_at: integer("deleted_at")
      .notNull()
      .$defaultFn(() => nowEpochMs()),
  },
  (table) => [
    primaryKey({ columns: [table.entity_type, table.entity_id] }),
    // Défense en base, redondante avec l'enum TS, contre une valeur hors domaine.
    check(
      "tombstones_entity_type_valid",
      sql`${table.entity_type} in ('article', 'feed', 'folder')`,
    ),
  ],
);

/**
 * Abonnements Web Push (#79, ADR 0018). App **mono-utilisateur, multi-appareils** :
 * une ligne par appareil abonné, clé par l'`endpoint` du service push (FCM,
 * Mozilla…). `p256dh`/`auth` sont les clés publiques du client, servant à
 * chiffrer le payload pour cet abonné (aes128gcm, RFC 8291). Pas de `user_id`
 * (propriétaire unique, cf. sessions `sub:"owner"`) ni d'`updated_at` (les
 * abonnements ne sont pas répliqués hors-ligne). Réabonner le même endpoint est
 * un upsert : les clés peuvent tourner côté navigateur.
 */
export const pushSubscriptions = sqliteTable("push_subscriptions", {
  /** URL du service push : identité de l'abonnement. */
  endpoint: text("endpoint").primaryKey(),
  /** Clé publique P-256 du client (base64url). */
  p256dh: text("p256dh").notNull(),
  /** Secret d'authentification du client (base64url). */
  auth: text("auth").notNull(),
  created_at: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
});
