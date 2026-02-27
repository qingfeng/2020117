-- Add platform ndebit + fee tracking columns to dvm_service table
ALTER TABLE `dvm_service` ADD COLUMN `platform_ndebit_encrypted` text;
ALTER TABLE `dvm_service` ADD COLUMN `platform_ndebit_iv` text;
ALTER TABLE `dvm_service` ADD COLUMN `fee_billed_msats` integer DEFAULT 0;
