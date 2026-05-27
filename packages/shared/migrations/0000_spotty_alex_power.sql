CREATE TABLE `settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`allowed_email` text NOT NULL,
	`refresh_interval_min` integer DEFAULT 30 NOT NULL,
	`purge_window_days` integer DEFAULT 60 NOT NULL,
	`theme` text DEFAULT 'system' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) NOT NULL,
	CONSTRAINT "settings_single_row" CHECK("settings"."id" = 1)
);
