CREATE TABLE `registration_receipt_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`competition_year` text DEFAULT '' NOT NULL,
	`qq_group` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `registration_receipts` (
	`user_id` text NOT NULL,
	`school_key` text NOT NULL,
	`school_name` text NOT NULL,
	`submission_id` text NOT NULL,
	`recipient_email` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`teacher_count` integer DEFAULT 0 NOT NULL,
	`student_count` integer DEFAULT 0 NOT NULL,
	`reasons_json` text DEFAULT '[]' NOT NULL,
	`assessed_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `school_key`),
	CONSTRAINT `chk_registration_receipts_status` CHECK(`status` IN ('qualified','unqualified'))
);
--> statement-breakpoint
CREATE INDEX `idx_registration_receipts_user_status` ON `registration_receipts` (`user_id`,`status`);

