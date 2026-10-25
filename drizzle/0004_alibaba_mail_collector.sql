CREATE TABLE `mail_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL DEFAULT '',
	`imap_host` text NOT NULL DEFAULT 'imap.qiye.aliyun.com',
	`imap_port` integer NOT NULL DEFAULT 993,
	`credential_ciphertext` text,
	`starts_at` text,
	`run_time` text NOT NULL DEFAULT '09:00',
	`timezone` text NOT NULL DEFAULT 'Asia/Shanghai',
	`interval_minutes` integer NOT NULL DEFAULT 1440,
	`enabled` integer NOT NULL DEFAULT 0,
	`next_run_at` text,
	`uid_validity` text,
	`last_uid` integer NOT NULL DEFAULT 0,
	`last_synced_at` text,
	`last_sync_status` text NOT NULL DEFAULT 'never',
	`last_sync_error` text,
	`sync_lock_token` text,
	`sync_lock_until` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_mail_settings_enabled_next_run` ON `mail_settings` (`enabled`,`next_run_at`) WHERE `mail_settings`.`enabled` = 1;
--> statement-breakpoint
CREATE TABLE `mail_messages` (
	`user_id` text NOT NULL,
	`mailbox_key` text NOT NULL,
	`mailbox_email` text NOT NULL,
	`uid_validity` text NOT NULL,
	`message_uid` integer NOT NULL,
	`message_id` text,
	`subject` text NOT NULL,
	`from_name` text,
	`from_address` text,
	`received_at` text,
	`raw_r2_key` text NOT NULL,
	`raw_size` integer NOT NULL,
	`attachment_count` integer NOT NULL DEFAULT 0,
	`collected_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `mailbox_key`, `uid_validity`, `message_uid`)
);
--> statement-breakpoint
CREATE INDEX `idx_mail_messages_user_collected_at` ON `mail_messages` (`user_id`,`collected_at`,`message_uid`,`mailbox_key`,`uid_validity`);
--> statement-breakpoint
CREATE INDEX `idx_mail_messages_user_message_id` ON `mail_messages` (`user_id`,`message_id`);
--> statement-breakpoint
CREATE TABLE `mail_attachments` (
	`user_id` text NOT NULL,
	`mailbox_key` text NOT NULL,
	`uid_validity` text NOT NULL,
	`message_uid` integer NOT NULL,
	`attachment_index` integer NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`r2_key` text NOT NULL,
	`category` text NOT NULL DEFAULT 'other',
	`collected_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `mailbox_key`, `uid_validity`, `message_uid`, `attachment_index`)
);
--> statement-breakpoint
CREATE INDEX `idx_mail_attachments_user_message` ON `mail_attachments` (`user_id`,`mailbox_key`,`uid_validity`,`message_uid`);
--> statement-breakpoint
CREATE TABLE `mail_issues` (
	`user_id` text NOT NULL,
	`issue_id` text NOT NULL,
	`mailbox_email` text,
	`message_uid` integer,
	`reason_code` text NOT NULL,
	`message` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `issue_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_mail_issues_user_created_at` ON `mail_issues` (`user_id`,`created_at`);
