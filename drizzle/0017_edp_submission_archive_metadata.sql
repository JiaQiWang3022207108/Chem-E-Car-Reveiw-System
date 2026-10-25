ALTER TABLE `edp_submissions` ADD `submission_round` integer CHECK (`submission_round` IS NULL OR `submission_round` BETWEEN 1 AND 5);
--> statement-breakpoint
ALTER TABLE `edp_submissions` ADD `submission_round_source` text DEFAULT 'legacy_unknown' NOT NULL;
--> statement-breakpoint
ALTER TABLE `edp_submissions` ADD `archive_format` text DEFAULT 'zip' NOT NULL CHECK (`archive_format` IN ('zip', '7z', 'rar'));
--> statement-breakpoint
ALTER TABLE `edp_submissions` ADD `embedded_registration_filename` text;
--> statement-breakpoint
ALTER TABLE `edp_submissions` ADD `embedded_registration_status` text DEFAULT 'none' NOT NULL CHECK (`embedded_registration_status` IN ('none', 'synced', 'older', 'invalid'));
--> statement-breakpoint
ALTER TABLE `edp_submissions` ADD `embedded_registration_message` text;
