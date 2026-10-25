CREATE TABLE `fanke_assistant_submissions` (
	`user_id` text NOT NULL,
	`form_id` text NOT NULL,
	`submission_id` text NOT NULL,
	`revision_hash` text NOT NULL,
	`revision_number` integer DEFAULT 1 NOT NULL,
	`submitted_at` text NOT NULL,
	`updated_at` text,
	`school_name` text NOT NULL,
	`file_count` integer DEFAULT 0 NOT NULL,
	`classified_count` integer DEFAULT 0 NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`last_changed_at` text NOT NULL,
	PRIMARY KEY(`user_id`,`form_id`,`submission_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_fanke_assistant_submissions_seen` ON `fanke_assistant_submissions` (`user_id`,`form_id`,`last_seen_at`);
--> statement-breakpoint
CREATE TABLE `fanke_assistant_files` (
	`user_id` text NOT NULL,
	`form_id` text NOT NULL,
	`submission_id` text NOT NULL,
	`file_key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`file_id` text,
	`filename` text NOT NULL,
	`download_url` text NOT NULL,
	`size` integer,
	`context` text,
	`kind` text,
	`last_seen_at` text NOT NULL,
	PRIMARY KEY(`user_id`,`form_id`,`submission_id`,`file_key`),
	CONSTRAINT `chk_fanke_assistant_files_kind` CHECK (`kind` IS NULL OR `kind` IN ('registration','edp','poster','video'))
);
--> statement-breakpoint
CREATE INDEX `idx_fanke_assistant_files_submission` ON `fanke_assistant_files` (`user_id`,`form_id`,`submission_id`);
--> statement-breakpoint
CREATE TABLE `fanke_assistant_runs` (
	`user_id` text PRIMARY KEY NOT NULL,
	`form_id` text NOT NULL,
	`scan_id` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`total_records` integer DEFAULT 0 NOT NULL,
	`new_records` integer DEFAULT 0 NOT NULL,
	`changed_records` integer DEFAULT 0 NOT NULL,
	`unchanged_records` integer DEFAULT 0 NOT NULL,
	`queued_files` integer DEFAULT 0 NOT NULL,
	`unclassified_files` integer DEFAULT 0 NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	`last_error` text,
	`updated_at` text NOT NULL,
	CONSTRAINT `chk_fanke_assistant_runs_status` CHECK (`status` IN ('running','completed','failed'))
);
