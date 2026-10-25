CREATE TABLE `__new_edp_receipt_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`competition_year` text DEFAULT '' NOT NULL,
	`submission_round` integer,
	`updated_at` text NOT NULL,
	CONSTRAINT `chk_edp_receipt_settings_round` CHECK(`submission_round` IS NULL OR `submission_round` IN (1, 2, 3, 4, 5))
);
--> statement-breakpoint
INSERT INTO `__new_edp_receipt_settings` (`user_id`, `competition_year`, `submission_round`, `updated_at`)
SELECT `user_id`, `competition_year`, `submission_round`, `updated_at` FROM `edp_receipt_settings`;
--> statement-breakpoint
DROP TABLE `edp_receipt_settings`;
--> statement-breakpoint
ALTER TABLE `__new_edp_receipt_settings` RENAME TO `edp_receipt_settings`;
