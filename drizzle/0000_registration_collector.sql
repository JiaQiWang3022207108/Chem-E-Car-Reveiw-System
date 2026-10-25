CREATE TABLE `collector_settings` (
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
CREATE INDEX `idx_collector_settings_enabled_next_run` ON `collector_settings` (`enabled`,`next_run_at`) WHERE `enabled` = 1;
--> statement-breakpoint
CREATE TABLE `collector_master_files` (
	`user_id` text PRIMARY KEY NOT NULL,
	`r2_key` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`uploaded_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `collector_registrations` (
	`user_id` text NOT NULL,
	`school_key` text NOT NULL,
	`school_name` text NOT NULL,
	`r2_key` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`submitted_at` text NOT NULL,
	`submission_id` text NOT NULL,
	`size` integer NOT NULL,
	`uploaded_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `school_key`)
);
--> statement-breakpoint
CREATE INDEX `idx_collector_registrations_user_school_name` ON `collector_registrations` (`user_id`,`school_name` COLLATE NOCASE);
