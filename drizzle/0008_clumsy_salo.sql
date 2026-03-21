CREATE TABLE `dvm_endorsement` (
	`id` text PRIMARY KEY NOT NULL,
	`endorser_pubkey` text NOT NULL,
	`target_pubkey` text NOT NULL,
	`rating` integer,
	`comment` text,
	`context` text,
	`nostr_event_id` text,
	`event_created_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `relay_event` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`kind` integer NOT NULL,
	`pubkey` text NOT NULL,
	`content_preview` text,
	`tags` text,
	`event_created_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `relay_event_event_id_unique` ON `relay_event` (`event_id`);--> statement-breakpoint
ALTER TABLE `external_dvm` ADD `lightning_address` text;--> statement-breakpoint
CREATE UNIQUE INDEX `user_nostr_pubkey_unique` ON `user` (`nostr_pubkey`);--> statement-breakpoint
ALTER TABLE `dvm_service` DROP COLUMN `platform_ndebit_encrypted`;--> statement-breakpoint
ALTER TABLE `dvm_service` DROP COLUMN `platform_ndebit_iv`;--> statement-breakpoint
ALTER TABLE `dvm_service` DROP COLUMN `fee_billed_msats`;--> statement-breakpoint
ALTER TABLE `dvm_service` DROP COLUMN `last_fee_at`;