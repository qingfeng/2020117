PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_comment` (
	`id` text PRIMARY KEY NOT NULL,
	`topic_id` text NOT NULL,
	`user_id` text,
	`content` text NOT NULL,
	`reply_to_id` text,
	`nostr_event_id` text,
	`nostr_author_pubkey` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`topic_id`) REFERENCES `topic`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_comment`("id", "topic_id", "user_id", "content", "reply_to_id", "nostr_event_id", "nostr_author_pubkey", "created_at", "updated_at") SELECT "id", "topic_id", "user_id", "content", "reply_to_id", "nostr_event_id", "nostr_author_pubkey", "created_at", "updated_at" FROM `comment`;--> statement-breakpoint
DROP TABLE `comment`;--> statement-breakpoint
ALTER TABLE `__new_comment` RENAME TO `comment`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_topic` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text,
	`user_id` text,
	`title` text NOT NULL,
	`content` text,
	`type` integer DEFAULT 0,
	`images` text,
	`nostr_event_id` text,
	`nostr_author_pubkey` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `group`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_topic`("id", "group_id", "user_id", "title", "content", "type", "images", "nostr_event_id", "nostr_author_pubkey", "created_at", "updated_at") SELECT "id", "group_id", "user_id", "title", "content", "type", "images", "nostr_event_id", "nostr_author_pubkey", "created_at", "updated_at" FROM `topic`;--> statement-breakpoint
DROP TABLE `topic`;--> statement-breakpoint
ALTER TABLE `__new_topic` RENAME TO `topic`;