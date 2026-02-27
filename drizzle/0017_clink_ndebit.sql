-- Add CLINK ndebit columns to user table
ALTER TABLE `user` ADD COLUMN `clink_ndebit_encrypted` text;
ALTER TABLE `user` ADD COLUMN `clink_ndebit_iv` text;
ALTER TABLE `user` ADD COLUMN `clink_ndebit_enabled` integer DEFAULT 0;
