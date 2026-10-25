CREATE TABLE `fanke_connectors` (
	`user_id` text PRIMARY KEY NOT NULL,
	`form_id` text,
	`secret_hash` text NOT NULL,
	`secret_prefix` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`last_event_at` text,
	`last_processed_at` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_fanke_connectors_secret_hash` ON `fanke_connectors` (`secret_hash`);
--> statement-breakpoint
CREATE TABLE `fanke_files` (
	`user_id` text NOT NULL,
	`queue_id` text NOT NULL,
	`form_id` text,
	`submission_id` text NOT NULL,
	`submitted_at` text NOT NULL,
	`school_name` text NOT NULL,
	`file_id` text,
	`filename` text NOT NULL,
	`download_url` text NOT NULL,
	`size` integer,
	`kind` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`source` text DEFAULT 'webhook' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`claim_token` text,
	`last_attempt_at` text,
	`next_attempt_at` text,
	`last_error` text,
	`received_at` text NOT NULL,
	`processed_at` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `queue_id`),
	CONSTRAINT `chk_fanke_files_kind` CHECK (`kind` IN ('registration','edp','poster','video')),
	CONSTRAINT `chk_fanke_files_status` CHECK (`status` IN ('pending','processing','retry','processed','ignored','invalid'))
);
--> statement-breakpoint
CREATE INDEX `idx_fanke_files_due` ON `fanke_files` (`user_id`,`kind`,`status`,`next_attempt_at`,`received_at`);
--> statement-breakpoint
CREATE INDEX `idx_fanke_files_submission` ON `fanke_files` (`user_id`,`submission_id`,`kind`);
--> statement-breakpoint
CREATE TABLE `fanke_issues` (
	`user_id` text NOT NULL,
	`issue_id` text NOT NULL,
	`form_id` text,
	`submission_id` text,
	`school_name` text,
	`reason_code` text NOT NULL,
	`message` text NOT NULL,
	`received_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `issue_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_fanke_issues_user_received` ON `fanke_issues` (`user_id`,`received_at`);
