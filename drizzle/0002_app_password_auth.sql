CREATE TABLE `auth_login_attempts` (
	`client_hash` text PRIMARY KEY NOT NULL,
	`window_started_at` integer NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_auth_login_attempts_locked_until` ON `auth_login_attempts` (`locked_until`);
--> statement-breakpoint
CREATE INDEX `idx_auth_login_attempts_updated_at` ON `auth_login_attempts` (`updated_at`);
