CREATE TABLE `edp_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`starts_at` text,
	`run_time` text DEFAULT '09:00' NOT NULL,
	`timezone` text DEFAULT 'Asia/Shanghai' NOT NULL,
	`interval_minutes` integer DEFAULT 1440 NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`next_run_at` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_edp_settings_enabled_next_run` ON `edp_settings` (`enabled`,`next_run_at`) WHERE `enabled` = 1;
--> statement-breakpoint
CREATE TABLE `edp_submissions` (
	`user_id` text NOT NULL,
	`school_key` text NOT NULL,
	`school_name` text NOT NULL,
	`r2_key` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`submitted_at` text NOT NULL,
	`submission_id` text NOT NULL,
	`size` integer NOT NULL,
	`file_count` integer NOT NULL,
	`uploaded_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `school_key`)
);
--> statement-breakpoint
CREATE INDEX `idx_edp_submissions_user_school_name` ON `edp_submissions` (`user_id`,`school_name` COLLATE NOCASE);
--> statement-breakpoint
CREATE TABLE `edp_issues` (
	`user_id` text NOT NULL,
	`school_key` text NOT NULL,
	`school_name` text NOT NULL,
	`filename` text NOT NULL,
	`submitted_at` text NOT NULL,
	`submission_id` text NOT NULL,
	`file_count` integer NOT NULL,
	`reason_code` text NOT NULL,
	`reason_codes_json` text NOT NULL,
	`reasons_json` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `school_key`)
);
--> statement-breakpoint
CREATE INDEX `idx_edp_issues_user_created_at` ON `edp_issues` (`user_id`,`created_at`);
