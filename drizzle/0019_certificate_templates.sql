CREATE TABLE `certificate_templates` (
  `user_id` text PRIMARY KEY NOT NULL,
  `event_name` text DEFAULT '' NOT NULL,
  `issuer_text` text DEFAULT '' NOT NULL,
  `stamp_r2_key` text,
  `stamp_filename` text,
  `stamp_content_type` text,
  `stamp_size` integer,
  `updated_at` text NOT NULL,
  CONSTRAINT `chk_certificate_templates_stamp_size`
    CHECK(`stamp_size` IS NULL OR (`stamp_size` > 0 AND `stamp_size` <= 5242880))
);
