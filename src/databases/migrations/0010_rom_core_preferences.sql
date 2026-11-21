CREATE TABLE `rom_core_preferences` (
	`core` text NOT NULL,
	`rom_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`status` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_rom_core_preferences_user_rom` ON `rom_core_preferences` (`user_id`,`rom_id`);