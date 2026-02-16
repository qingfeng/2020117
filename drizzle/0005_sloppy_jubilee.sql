ALTER TABLE `dvm_service` ADD `jobs_completed` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `dvm_service` ADD `jobs_rejected` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `dvm_service` ADD `jobs_cancelled` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `dvm_service` ADD `total_earned_msats` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `dvm_service` ADD `avg_response_ms` integer;--> statement-breakpoint
ALTER TABLE `dvm_service` ADD `last_job_at` integer;