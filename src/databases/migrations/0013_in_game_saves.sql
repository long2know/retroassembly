CREATE TABLE `in_game_saves` (
	`core` text NOT NULL,
	`data` text NOT NULL,
	`rom_id` text NOT NULL,
	`source` text NOT NULL,
	`user_id` text NOT NULL,
	`version` text NOT NULL,
	PRIMARY KEY(`user_id`, `rom_id`, `core`, `source`)
);
