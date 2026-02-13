ALTER TABLE `user` ADD `nwc_encrypted` text;--> statement-breakpoint
ALTER TABLE `user` ADD `nwc_iv` text;--> statement-breakpoint
ALTER TABLE `user` ADD `nwc_enabled` integer DEFAULT 0;