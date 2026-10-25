CREATE TABLE `edp_receipt_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`competition_year` text DEFAULT '' NOT NULL,
	`submission_round` integer,
	`updated_at` text NOT NULL,
	CONSTRAINT `chk_edp_receipt_settings_round` CHECK(`submission_round` IS NULL OR `submission_round` IN (1, 2))
);
