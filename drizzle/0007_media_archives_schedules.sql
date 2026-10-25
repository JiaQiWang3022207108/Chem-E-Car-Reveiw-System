CREATE TABLE `shared_media_assets_v2` (
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`school_key` text NOT NULL,
	`school_name` text NOT NULL,
	`r2_key` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`submitted_at` text NOT NULL,
	`submission_id` text NOT NULL,
	`uploaded_at` text NOT NULL,
	`source` text DEFAULT 'web' NOT NULL,
	`source_ref` text,
	PRIMARY KEY(`user_id`, `kind`, `school_key`),
	CONSTRAINT `chk_shared_media_assets_kind` CHECK(`kind` IN ('poster', 'video')),
	CONSTRAINT `chk_shared_media_assets_source` CHECK(`source` IN ('web', 'email')),
	CONSTRAINT `chk_shared_media_assets_size` CHECK(`size` > 0 AND `size` <= 209715200)
);
--> statement-breakpoint
INSERT INTO `shared_media_assets_v2` (
	`user_id`, `kind`, `school_key`, `school_name`, `r2_key`, `filename`,
	`content_type`, `size`, `submitted_at`, `submission_id`, `uploaded_at`,
	`source`, `source_ref`
)
SELECT
	`user_id`, `kind`, `school_key`, `school_name`, `r2_key`, `filename`,
	`content_type`, `size`, `submitted_at`, `submission_id`, `uploaded_at`,
	`source`, `source_ref`
FROM `shared_media_assets`;
--> statement-breakpoint
DROP TABLE `shared_media_assets`;
--> statement-breakpoint
ALTER TABLE `shared_media_assets_v2` RENAME TO `shared_media_assets`;
--> statement-breakpoint
CREATE INDEX `idx_shared_media_assets_user_kind_school_name`
ON `shared_media_assets` (`user_id`, `kind`, `school_name` COLLATE NOCASE);
--> statement-breakpoint
CREATE TABLE `media_collector_settings` (
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`starts_at` text,
	`run_time` text DEFAULT '09:00' NOT NULL,
	`timezone` text DEFAULT 'Asia/Shanghai' NOT NULL,
	`interval_minutes` integer DEFAULT 1440 NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`next_run_at` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `kind`),
	CONSTRAINT `chk_media_collector_settings_kind` CHECK(`kind` IN ('poster', 'video'))
);
--> statement-breakpoint
CREATE INDEX `idx_media_collector_settings_enabled_next_run`
ON `media_collector_settings` (`enabled`, `next_run_at`) WHERE `enabled` = 1;
--> statement-breakpoint
CREATE TABLE `media_upload_sessions` (
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`school_key` text NOT NULL,
	`school_name` text NOT NULL,
	`filename` text NOT NULL,
	`total_size` integer NOT NULL,
	`submitted_at` text NOT NULL,
	`submission_id` text NOT NULL,
	`temp_r2_key` text NOT NULL,
	`r2_upload_id` text NOT NULL,
	`part_size` integer NOT NULL,
	`content_type` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `session_id`),
	CONSTRAINT `chk_media_upload_sessions_kind` CHECK(`kind` IN ('poster', 'video')),
	CONSTRAINT `chk_media_upload_sessions_size` CHECK(`total_size` > 0 AND `total_size` <= 209715200)
);
--> statement-breakpoint
CREATE INDEX `idx_media_upload_sessions_expires_at`
ON `media_upload_sessions` (`expires_at`);
