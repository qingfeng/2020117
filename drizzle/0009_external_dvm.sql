CREATE TABLE `external_dvm` (
  `id` text PRIMARY KEY NOT NULL,
  `pubkey` text NOT NULL,
  `d_tag` text NOT NULL,
  `kind` integer NOT NULL,
  `name` text,
  `picture` text,
  `about` text,
  `pricing_min` integer,
  `pricing_max` integer,
  `reputation` text,
  `event_id` text NOT NULL,
  `event_created_at` integer NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
CREATE UNIQUE INDEX `external_dvm_event_id_unique` ON `external_dvm` (`event_id`);
CREATE UNIQUE INDEX `external_dvm_pubkey_dtag_unique` ON `external_dvm` (`pubkey`, `d_tag`);
CREATE INDEX `external_dvm_pubkey_idx` ON `external_dvm` (`pubkey`);
