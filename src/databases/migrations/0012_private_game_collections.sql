CREATE TABLE `game_collection_roms` (
	`collection_id` text NOT NULL,
	`rom_id` text NOT NULL,
	PRIMARY KEY(`collection_id`, `rom_id`),
	FOREIGN KEY (`collection_id`) REFERENCES `game_collections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `game_collections` (
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`status` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_game_collections_user_name` ON `game_collections` (`user_id`,`name_key`) WHERE "game_collections"."status" = 1;