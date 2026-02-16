CREATE TABLE `nostr_report` (
  `id` text PRIMARY KEY NOT NULL,
  `nostr_event_id` text,
  `reporter_pubkey` text NOT NULL,
  `target_pubkey` text NOT NULL,
  `target_event_id` text,
  `report_type` text NOT NULL,
  `content` text,
  `created_at` integer NOT NULL
);
CREATE UNIQUE INDEX `nostr_report_nostr_event_id_unique` ON `nostr_report` (`nostr_event_id`);
CREATE INDEX `nostr_report_target_pubkey_idx` ON `nostr_report` (`target_pubkey`);
