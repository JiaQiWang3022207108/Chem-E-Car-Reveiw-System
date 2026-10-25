ALTER TABLE `fanke_assistant_runs` ADD COLUMN `target_kind` text DEFAULT 'registration' NOT NULL
  CONSTRAINT `chk_fanke_assistant_runs_target_kind` CHECK (`target_kind` IN ('registration','edp','poster','video'));
