CREATE TABLE `edp_review_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`competition_year` text DEFAULT '' NOT NULL,
	`safety_reviewer_name` text DEFAULT '' NOT NULL,
	`safety_reviewer_email` text DEFAULT '' NOT NULL,
	`expert_member_name` text DEFAULT '' NOT NULL,
	`expert_member_email` text DEFAULT '' NOT NULL,
	`template_version` text DEFAULT 'v1' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `edp_review_jobs` (
	`user_id` text NOT NULL,
	`job_id` text NOT NULL,
	`school_key` text NOT NULL,
	`school_name` text NOT NULL,
	`submission_id` text NOT NULL,
	`submitted_at` text NOT NULL,
	`submission_round` integer NOT NULL,
	`source_r2_key` text,
	`source_filename` text,
	`rule_version` text NOT NULL,
	`template_version` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`overall_status` text DEFAULT 'pending' NOT NULL,
	`superseded_by` text,
	`last_error` text,
	`reviewed_at` text,
	`finalized_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `job_id`),
	CONSTRAINT `chk_edp_review_jobs_round` CHECK(`submission_round` BETWEEN 1 AND 5),
	CONSTRAINT `chk_edp_review_jobs_status` CHECK(`status` IN ('queued','processing','needs_human','ready','completed','failed','superseded')),
	CONSTRAINT `chk_edp_review_jobs_overall` CHECK(`overall_status` IN ('pending','passed','failed','needs_human'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_edp_review_jobs_submission_rule` ON `edp_review_jobs` (`user_id`,`school_key`,`submission_id`,`rule_version`);
--> statement-breakpoint
CREATE INDEX `idx_edp_review_jobs_school_updated` ON `edp_review_jobs` (`user_id`,`school_key`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `idx_edp_review_jobs_status_updated` ON `edp_review_jobs` (`user_id`,`status`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `edp_review_items` (
	`user_id` text NOT NULL,
	`job_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`worksheet_name` text DEFAULT '2) EDP Evaluation' NOT NULL,
	`template_row` integer NOT NULL,
	`automatic_status` text NOT NULL,
	`final_status` text NOT NULL,
	`suggested_comment` text,
	`final_comment` text,
	`evidence_json` text DEFAULT '[]' NOT NULL,
	`document_name` text,
	`page_number` integer,
	`override_actor` text,
	`override_previous_status` text,
	`overridden_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `job_id`, `rule_id`),
	CONSTRAINT `chk_edp_review_items_row` CHECK(`template_row` BETWEEN 1 AND 1048576),
	CONSTRAINT `chk_edp_review_items_page` CHECK(`page_number` IS NULL OR `page_number` >= 1),
	CONSTRAINT `chk_edp_review_items_automatic_status` CHECK(`automatic_status` IN ('yes','no','not_applicable','needs_human')),
	CONSTRAINT `chk_edp_review_items_final_status` CHECK(`final_status` IN ('yes','no','not_applicable','needs_human')),
	CONSTRAINT `chk_edp_review_items_previous_status` CHECK(`override_previous_status` IS NULL OR `override_previous_status` IN ('yes','no','not_applicable','needs_human'))
);
--> statement-breakpoint
CREATE INDEX `idx_edp_review_items_job_status` ON `edp_review_items` (`user_id`,`job_id`,`final_status`,`template_row`);
--> statement-breakpoint
CREATE TABLE `edp_review_exports` (
	`user_id` text NOT NULL,
	`job_id` text NOT NULL,
	`export_type` text NOT NULL,
	`r2_key` text NOT NULL,
	`filename` text NOT NULL,
	`size` integer NOT NULL,
	`rule_version` text NOT NULL,
	`template_version` text NOT NULL,
	`submission_id` text NOT NULL,
	`generated_at` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `job_id`, `export_type`),
	CONSTRAINT `chk_edp_review_exports_type` CHECK(`export_type` IN ('draft','final')),
	CONSTRAINT `chk_edp_review_exports_size` CHECK(`size` > 0)
);
--> statement-breakpoint
CREATE INDEX `idx_edp_review_exports_generated` ON `edp_review_exports` (`user_id`,`generated_at`);
