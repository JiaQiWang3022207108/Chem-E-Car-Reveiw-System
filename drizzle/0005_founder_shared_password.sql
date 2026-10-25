CREATE TABLE `app_security_settings` (
	`singleton_id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`shared_password_hash` text NOT NULL,
	`password_version` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `chk_app_security_settings_singleton` CHECK(`app_security_settings`.`singleton_id` = 1),
	CONSTRAINT `chk_app_security_settings_password_version` CHECK(`app_security_settings`.`password_version` >= 1)
);
