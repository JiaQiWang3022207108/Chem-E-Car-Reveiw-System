ALTER TABLE `shared_media_assets` ADD COLUMN `source` text DEFAULT 'web' NOT NULL CHECK (`source` IN ('web', 'email'));
--> statement-breakpoint
ALTER TABLE `shared_media_assets` ADD COLUMN `source_ref` text;
--> statement-breakpoint
CREATE TABLE `mail_media_candidates` (
	`user_id` text NOT NULL,
	`candidate_id` text NOT NULL,
	`mailbox_key` text NOT NULL,
	`mailbox_email` text NOT NULL,
	`uid_validity` text NOT NULL,
	`message_uid` integer NOT NULL,
	`attachment_index` integer NOT NULL,
	`kind` text NOT NULL,
	`filename` text NOT NULL,
	`subject` text NOT NULL,
	`sender` text,
	`received_at` text,
	`attachment_r2_key` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reason` text NOT NULL,
	`inferred_school_name` text,
	`assigned_school_name` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`last_attempt_at` text,
	`assigned_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `candidate_id`),
	CONSTRAINT `chk_mail_media_candidates_kind` CHECK(`kind` IN ('poster', 'video')),
	CONSTRAINT `chk_mail_media_candidates_status` CHECK(`status` IN ('pending', 'retry', 'processing', 'assigned', 'dismissed', 'invalid'))
);
--> statement-breakpoint
CREATE INDEX `idx_mail_media_candidates_user_status_created` ON `mail_media_candidates` (`user_id`,`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_mail_media_candidates_message` ON `mail_media_candidates` (`user_id`,`mailbox_key`,`uid_validity`,`message_uid`);
