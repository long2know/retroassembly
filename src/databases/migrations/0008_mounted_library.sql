PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_roms` (
	`file_name` text NOT NULL,
	`game_boxart_file_ids` text,
	`game_description` text,
	`game_developer` text,
	`game_genres` text,
	`game_name` text,
	`game_players` integer,
	`game_publisher` text,
	`game_rating` integer,
	`game_release_date` integer,
	`game_release_year` integer,
	`game_thumbnail_file_ids` text,
	`launchbox_game_id` integer,
	`libretro_game_id` text,
	`platform` text NOT NULL,
	`raw_game_metadata` text,
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`status` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL,
	`file_id` text NOT NULL,
	`user_id` text,
	`mounted_source` text
);
--> statement-breakpoint
INSERT INTO `__new_roms`("file_name", "game_boxart_file_ids", "game_description", "game_developer", "game_genres", "game_name", "game_players", "game_publisher", "game_rating", "game_release_date", "game_release_year", "game_thumbnail_file_ids", "launchbox_game_id", "libretro_game_id", "platform", "raw_game_metadata", "created_at", "id", "status", "updated_at", "file_id", "user_id", "mounted_source") SELECT "file_name", "game_boxart_file_ids", "game_description", "game_developer", "game_genres", "game_name", "game_players", "game_publisher", "game_rating", "game_release_date", "game_release_year", "game_thumbnail_file_ids", "launchbox_game_id", "libretro_game_id", "platform", "raw_game_metadata", "created_at", "id", "status", "updated_at", "file_id", "user_id", NULL FROM `roms`;--> statement-breakpoint
DROP TABLE `roms`;--> statement-breakpoint
ALTER TABLE `__new_roms` RENAME TO `roms`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_roms_user_status_platform` ON `roms` (`user_id`,`status`,`platform`);--> statement-breakpoint
CREATE INDEX `idx_roms_user_status_created` ON `roms` (`user_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_roms_user_status_released` ON `roms` (`user_id`,`status`,`game_release_date`);--> statement-breakpoint
CREATE INDEX `idx_roms_user_status_name` ON `roms` (`user_id`,`status`,`file_name`);--> statement-breakpoint
CREATE INDEX `idx_roms_file_status` ON `roms` (`file_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_roms_user_platform_filename` ON `roms` (`user_id`,`platform`,`file_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_roms_mounted_file` ON `roms` (`file_id`) WHERE "roms"."user_id" IS NULL;