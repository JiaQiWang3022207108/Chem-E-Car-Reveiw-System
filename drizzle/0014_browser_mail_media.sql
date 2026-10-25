CREATE TABLE `browser_mail_scan_checkpoints` (
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`mailbox_key` text NOT NULL DEFAULT '',
	`last_message_key` text,
	`last_scan_at` text,
	`last_error` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `kind`),
	CONSTRAINT `chk_browser_mail_scan_checkpoints_kind` CHECK(`kind` IN ('poster', 'video'))
);
--> statement-breakpoint
CREATE INDEX `idx_browser_mail_scan_checkpoints_updated` ON `browser_mail_scan_checkpoints` (`user_id`, `updated_at`);
--> statement-breakpoint
CREATE TABLE `browser_mail_seen_attachments` (
	`user_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`kind` text,
	`school_name` text,
	`filename` text NOT NULL,
	`size` integer NOT NULL,
	`received_at` text NOT NULL,
	`source_ref` text NOT NULL,
	`asset_school_key` text,
	`status` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `fingerprint`),
	CONSTRAINT `chk_browser_mail_seen_attachments_kind` CHECK(`kind` IS NULL OR `kind` IN ('poster', 'video')),
	CONSTRAINT `chk_browser_mail_seen_attachments_status` CHECK(`status` IN ('pending', 'uploaded', 'candidate', 'missing', 'invalid')),
	CONSTRAINT `chk_browser_mail_seen_attachments_size` CHECK(`size` >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_browser_mail_seen_status_received` ON `browser_mail_seen_attachments` (`user_id`, `status`, `received_at`);
