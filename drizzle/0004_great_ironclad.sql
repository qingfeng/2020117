PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_comment_like` (
	`id` text PRIMARY KEY NOT NULL,
	`comment_id` text NOT NULL,
	`user_id` text,
	`nostr_author_pubkey` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`comment_id`) REFERENCES `comment`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_comment_like`("id", "comment_id", "user_id", "nostr_author_pubkey", "created_at") SELECT "id", "comment_id", "user_id", "nostr_author_pubkey", "created_at" FROM `comment_like`;--> statement-breakpoint
DROP TABLE `comment_like`;--> statement-breakpoint
ALTER TABLE `__new_comment_like` RENAME TO `comment_like`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_topic_like` (
	`id` text PRIMARY KEY NOT NULL,
	`topic_id` text NOT NULL,
	`user_id` text,
	`nostr_author_pubkey` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`topic_id`) REFERENCES `topic`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_topic_like`("id", "topic_id", "user_id", "nostr_author_pubkey", "created_at") SELECT "id", "topic_id", "user_id", "nostr_author_pubkey", "created_at" FROM `topic_like`;--> statement-breakpoint
DROP TABLE `topic_like`;--> statement-breakpoint
ALTER TABLE `__new_topic_like` RENAME TO `topic_like`;--> statement-breakpoint
ALTER TABLE `user` ADD `nip05_enabled` integer DEFAULT 0;--> statement-breakpoint
CREATE UNIQUE INDEX `dvm_service_user_id_unique` ON `dvm_service` (`user_id`);