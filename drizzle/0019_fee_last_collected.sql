-- Add last fee collection timestamp to dvm_service
ALTER TABLE `dvm_service` ADD COLUMN `last_fee_at` integer;
