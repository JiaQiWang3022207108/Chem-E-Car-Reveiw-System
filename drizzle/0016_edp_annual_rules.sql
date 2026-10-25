CREATE TABLE `edp_rule_documents` (
	`user_id` text NOT NULL,
	`document_id` text NOT NULL,
	`applicable_year` integer NOT NULL,
	`entered_year` integer NOT NULL,
	`detected_year` integer,
	`filename` text NOT NULL,
	`r2_key` text NOT NULL,
	`sha256` text NOT NULL,
	`size` integer NOT NULL,
	`status` text DEFAULT 'processing' NOT NULL,
	`parse_warnings_json` text DEFAULT '[]' NOT NULL,
	`parse_error` text,
	`builtin_rule_version` text NOT NULL,
	`rule_version` text NOT NULL,
	`year_conflict_confirmed` integer DEFAULT 0 NOT NULL,
	`confirmed_at` text,
	`activated_at` text,
	`archived_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `document_id`),
	CONSTRAINT `chk_edp_rule_documents_year` CHECK(`applicable_year` BETWEEN 2000 AND 2200 AND `entered_year` BETWEEN 2000 AND 2200 AND (`detected_year` IS NULL OR `detected_year` BETWEEN 2000 AND 2200)),
	CONSTRAINT `chk_edp_rule_documents_size` CHECK(`size` > 0 AND `size` <= 52428800),
	CONSTRAINT `chk_edp_rule_documents_status` CHECK(`status` IN ('processing','needs_confirmation','active','archived','failed')),
	CONSTRAINT `chk_edp_rule_documents_sha256` CHECK(length(`sha256`) = 64),
	CONSTRAINT `chk_edp_rule_documents_year_conflict` CHECK(`year_conflict_confirmed` IN (0,1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_edp_rule_documents_year_sha` ON `edp_rule_documents` (`user_id`,`applicable_year`,`sha256`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_edp_rule_documents_active_year` ON `edp_rule_documents` (`user_id`,`applicable_year`) WHERE `status` = 'active';
--> statement-breakpoint
CREATE INDEX `idx_edp_rule_documents_year_status_created` ON `edp_rule_documents` (`user_id`,`applicable_year`,`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_edp_rule_documents_rule_version` ON `edp_rule_documents` (`user_id`,`rule_version`);
--> statement-breakpoint
CREATE TABLE `edp_rule_facts` (
	`user_id` text NOT NULL,
	`document_id` text NOT NULL,
	`fact_id` text NOT NULL,
	`category` text NOT NULL,
	`section` text DEFAULT '' NOT NULL,
	`normalized_requirement` text NOT NULL,
	`operator` text NOT NULL,
	`structured_value` text,
	`structured_unit` text,
	`condition_text` text,
	`source_page` integer NOT NULL,
	`evidence_excerpt` text NOT NULL,
	`confidence` text NOT NULL,
	`confirmation_status` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `document_id`, `fact_id`),
	CONSTRAINT `chk_edp_rule_facts_category` CHECK(`category` IN ('numeric_limit','required','prohibited','allowed','conditional')),
	CONSTRAINT `chk_edp_rule_facts_operator` CHECK(`operator` IN ('lt','lte','eq','gte','gt','must','must_not','may','conditional')),
	CONSTRAINT `chk_edp_rule_facts_page` CHECK(`source_page` >= 1),
	CONSTRAINT `chk_edp_rule_facts_confidence` CHECK(`confidence` IN ('high','medium','low')),
	CONSTRAINT `chk_edp_rule_facts_confirmation` CHECK(`confirmation_status` IN ('pending','confirmed','rejected'))
);
--> statement-breakpoint
CREATE INDEX `idx_edp_rule_facts_document_page` ON `edp_rule_facts` (`user_id`,`document_id`,`source_page`,`fact_id`);
--> statement-breakpoint
ALTER TABLE `edp_review_settings` ADD `active_rule_document_id` text;
--> statement-breakpoint
ALTER TABLE `edp_review_settings` ADD `active_rule_version` text;
--> statement-breakpoint
ALTER TABLE `edp_review_items` ADD `is_blocking` integer DEFAULT 1 NOT NULL CHECK(`is_blocking` IN (0,1));
--> statement-breakpoint
ALTER TABLE `edp_review_items` ADD `rule_source` text DEFAULT 'builtin:v1' NOT NULL;
