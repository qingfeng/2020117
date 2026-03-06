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

CREATE UNIQUE INDEX `relay_event_event_id_unique` ON `relay_event` (`event_id`);
CREATE INDEX `relay_event_kind_idx` ON `relay_event` (`kind`);
CREATE INDEX `relay_event_created_at_idx` ON `relay_event` (`event_created_at`);
