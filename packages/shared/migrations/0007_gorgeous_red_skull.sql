ALTER TABLE `feeds` ADD `consecutive_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `feeds` ADD `last_error` text;--> statement-breakpoint
ALTER TABLE `feeds` ADD `last_error_at` text;