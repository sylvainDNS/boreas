CREATE TABLE `tombstones` (
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`deleted_at` integer NOT NULL,
	PRIMARY KEY(`entity_type`, `entity_id`),
	CONSTRAINT "tombstones_entity_type_valid" CHECK("tombstones"."entity_type" in ('article', 'feed', 'folder'))
);
--> statement-breakpoint
-- updated_at (#69, ADR 0018) : curseur de delta sync en epoch-ms. SQLite refuse
-- un DEFAULT non-constant (`unixepoch()`) sur un ADD COLUMN NOT NULL ; on backfille
-- donc les lignes existantes avec un littéral figé (epoch-ms de la migration,
-- 2026-06-14T00:00:00Z). Les nouveaux INSERT posent leur propre Date.now() côté
-- code (`$defaultFn`), ce DEFAULT SQL ne sert qu'au backfill de migration.
ALTER TABLE `articles` ADD `updated_at` integer DEFAULT 1781395200000 NOT NULL;--> statement-breakpoint
ALTER TABLE `feeds` ADD `updated_at` integer DEFAULT 1781395200000 NOT NULL;--> statement-breakpoint
ALTER TABLE `folders` ADD `updated_at` integer DEFAULT 1781395200000 NOT NULL;