CREATE TABLE `shared_media_assets` (
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
	PRIMARY KEY(`user_id`, `kind`, `school_key`),
	CONSTRAINT `chk_shared_media_assets_kind` CHECK(`kind` IN ('poster', 'video')),
	CONSTRAINT `chk_shared_media_assets_size` CHECK(`size` > 0 AND (
		(`kind` = 'poster' AND `size` <= 52428800)
		OR (`kind` = 'video' AND `size` <= 99614720)
	))
);
--> statement-breakpoint
CREATE INDEX `idx_shared_media_assets_user_kind_school_name` ON `shared_media_assets` (`user_id`,`kind`,`school_name` COLLATE NOCASE);
