import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const certificateTemplates = sqliteTable("certificate_templates", {
  userId: text("user_id").primaryKey(),
  eventName: text("event_name").notNull().default(""),
  issuerText: text("issuer_text").notNull().default(""),
  stampR2Key: text("stamp_r2_key"),
  stampFilename: text("stamp_filename"),
  stampContentType: text("stamp_content_type"),
  stampSize: integer("stamp_size"),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  check("chk_certificate_templates_stamp_size", sql`${table.stampSize} IS NULL OR (${table.stampSize} > 0 AND ${table.stampSize} <= 5242880)`),
]);

export const collectorSettings = sqliteTable(
  "collector_settings",
  {
    userId: text("user_id").primaryKey(),
    startsAt: text("starts_at"),
    runTime: text("run_time").notNull().default("09:00"),
    timezone: text("timezone").notNull().default("Asia/Shanghai"),
    intervalMinutes: integer("interval_minutes").notNull().default(1440),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    nextRunAt: text("next_run_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("idx_collector_settings_enabled_next_run").on(table.enabled, table.nextRunAt).where(sql`${table.enabled} = 1`)],
);

export const collectorMasterFiles = sqliteTable("collector_master_files", {
  userId: text("user_id").primaryKey(),
  r2Key: text("r2_key").notNull(),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  size: integer("size").notNull(),
  uploadedAt: text("uploaded_at").notNull(),
});

export const collectorRegistrations = sqliteTable(
  "collector_registrations",
  {
    userId: text("user_id").notNull(),
    schoolKey: text("school_key").notNull(),
    schoolName: text("school_name").notNull(),
    r2Key: text("r2_key").notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    submittedAt: text("submitted_at").notNull(),
    submissionId: text("submission_id").notNull(),
    size: integer("size").notNull(),
    uploadedAt: text("uploaded_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.schoolKey] }),
    index("idx_collector_registrations_user_school_name").on(table.userId, sql`${table.schoolName} COLLATE NOCASE`),
  ],
);

export const registrationReceiptSettings = sqliteTable("registration_receipt_settings", {
  userId: text("user_id").primaryKey(),
  competitionYear: text("competition_year").notNull().default(""),
  qqGroup: text("qq_group").notNull().default(""),
  updatedAt: text("updated_at").notNull(),
});

export const registrationReceipts = sqliteTable(
  "registration_receipts",
  {
    userId: text("user_id").notNull(),
    schoolKey: text("school_key").notNull(),
    schoolName: text("school_name").notNull(),
    submissionId: text("submission_id").notNull(),
    recipientEmail: text("recipient_email").notNull().default(""),
    status: text("status").notNull(),
    teacherCount: integer("teacher_count").notNull().default(0),
    studentCount: integer("student_count").notNull().default(0),
    reasonsJson: text("reasons_json").notNull().default("[]"),
    assessedAt: text("assessed_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.schoolKey] }),
    check("chk_registration_receipts_status", sql`${table.status} IN ('qualified','unqualified')`),
    index("idx_registration_receipts_user_status").on(table.userId, table.status),
  ],
);

export const edpSettings = sqliteTable(
  "edp_settings",
  {
    userId: text("user_id").primaryKey(),
    startsAt: text("starts_at"),
    runTime: text("run_time").notNull().default("09:00"),
    timezone: text("timezone").notNull().default("Asia/Shanghai"),
    intervalMinutes: integer("interval_minutes").notNull().default(1440),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    nextRunAt: text("next_run_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("idx_edp_settings_enabled_next_run").on(table.enabled, table.nextRunAt).where(sql`${table.enabled} = 1`)],
);

export const edpReceiptSettings = sqliteTable("edp_receipt_settings", {
  userId: text("user_id").primaryKey(),
  competitionYear: text("competition_year").notNull().default(""),
  submissionRound: integer("submission_round"),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  check("chk_edp_receipt_settings_round", sql`${table.submissionRound} IS NULL OR ${table.submissionRound} IN (1, 2, 3, 4, 5)`),
]);

export const edpSubmissions = sqliteTable(
  "edp_submissions",
  {
    userId: text("user_id").notNull(),
    schoolKey: text("school_key").notNull(),
    schoolName: text("school_name").notNull(),
    r2Key: text("r2_key").notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    submittedAt: text("submitted_at").notNull(),
    submissionId: text("submission_id").notNull(),
    size: integer("size").notNull(),
    fileCount: integer("file_count").notNull(),
    uploadedAt: text("uploaded_at").notNull(),
    submissionRound: integer("submission_round"),
    submissionRoundSource: text("submission_round_source").notNull().default("legacy_unknown"),
    archiveFormat: text("archive_format").notNull().default("zip"),
    embeddedRegistrationFilename: text("embedded_registration_filename"),
    embeddedRegistrationStatus: text("embedded_registration_status").notNull().default("none"),
    embeddedRegistrationMessage: text("embedded_registration_message"),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.schoolKey] }),
    index("idx_edp_submissions_user_school_name").on(table.userId, sql`${table.schoolName} COLLATE NOCASE`),
    check("chk_edp_submissions_round", sql`${table.submissionRound} IS NULL OR ${table.submissionRound} BETWEEN 1 AND 5`),
    check("chk_edp_submissions_archive_format", sql`${table.archiveFormat} IN ('zip', '7z', 'rar')`),
    check("chk_edp_submissions_registration_status", sql`${table.embeddedRegistrationStatus} IN ('none', 'synced', 'older', 'invalid')`),
  ],
);

export const edpIssues = sqliteTable(
  "edp_issues",
  {
    userId: text("user_id").notNull(),
    schoolKey: text("school_key").notNull(),
    schoolName: text("school_name").notNull(),
    filename: text("filename").notNull(),
    submittedAt: text("submitted_at").notNull(),
    submissionId: text("submission_id").notNull(),
    fileCount: integer("file_count").notNull(),
    reasonCode: text("reason_code").notNull(),
    reasonCodesJson: text("reason_codes_json").notNull(),
    reasonsJson: text("reasons_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.schoolKey] }),
    index("idx_edp_issues_user_created_at").on(table.userId, table.createdAt),
  ],
);

export const authLoginAttempts = sqliteTable(
  "auth_login_attempts",
  {
    clientHash: text("client_hash").primaryKey(),
    windowStartedAt: integer("window_started_at").notNull(),
    failureCount: integer("failure_count").notNull().default(0),
    lockedUntil: integer("locked_until"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_auth_login_attempts_locked_until").on(table.lockedUntil),
    index("idx_auth_login_attempts_updated_at").on(table.updatedAt),
  ],
);

export const appSecuritySettings = sqliteTable(
  "app_security_settings",
  {
    singletonId: integer("singleton_id").primaryKey().default(1),
    sharedPasswordHash: text("shared_password_hash").notNull(),
    passwordVersion: integer("password_version").notNull().default(1),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("chk_app_security_settings_singleton", sql`${table.singletonId} = 1`),
    check("chk_app_security_settings_password_version", sql`${table.passwordVersion} >= 1`),
  ],
);

export const mailSettings = sqliteTable(
  "mail_settings",
  {
    userId: text("user_id").primaryKey(),
    email: text("email").notNull().default(""),
    imapHost: text("imap_host").notNull().default("imap.qiye.aliyun.com"),
    imapPort: integer("imap_port").notNull().default(993),
    credentialCiphertext: text("credential_ciphertext"),
    startsAt: text("starts_at"),
    runTime: text("run_time").notNull().default("09:00"),
    timezone: text("timezone").notNull().default("Asia/Shanghai"),
    intervalMinutes: integer("interval_minutes").notNull().default(1440),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    nextRunAt: text("next_run_at"),
    uidValidity: text("uid_validity"),
    lastUid: integer("last_uid").notNull().default(0),
    lastSyncedAt: text("last_synced_at"),
    lastSyncStatus: text("last_sync_status").notNull().default("never"),
    lastSyncError: text("last_sync_error"),
    syncLockToken: text("sync_lock_token"),
    syncLockUntil: text("sync_lock_until"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_mail_settings_enabled_next_run").on(table.enabled, table.nextRunAt).where(sql`${table.enabled} = 1`),
  ],
);

export const mailMessages = sqliteTable(
  "mail_messages",
  {
    userId: text("user_id").notNull(),
    mailboxKey: text("mailbox_key").notNull(),
    mailboxEmail: text("mailbox_email").notNull(),
    uidValidity: text("uid_validity").notNull(),
    messageUid: integer("message_uid").notNull(),
    messageId: text("message_id"),
    subject: text("subject").notNull(),
    fromName: text("from_name"),
    fromAddress: text("from_address"),
    receivedAt: text("received_at"),
    rawR2Key: text("raw_r2_key").notNull(),
    rawSize: integer("raw_size").notNull(),
    attachmentCount: integer("attachment_count").notNull().default(0),
    collectedAt: text("collected_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.mailboxKey, table.uidValidity, table.messageUid] }),
    index("idx_mail_messages_user_collected_at").on(
      table.userId,
      table.collectedAt,
      table.messageUid,
      table.mailboxKey,
      table.uidValidity,
    ),
    index("idx_mail_messages_user_message_id").on(table.userId, table.messageId),
  ],
);

export const mailAttachments = sqliteTable(
  "mail_attachments",
  {
    userId: text("user_id").notNull(),
    mailboxKey: text("mailbox_key").notNull(),
    uidValidity: text("uid_validity").notNull(),
    messageUid: integer("message_uid").notNull(),
    attachmentIndex: integer("attachment_index").notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    r2Key: text("r2_key").notNull(),
    category: text("category").notNull().default("other"),
    collectedAt: text("collected_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.mailboxKey, table.uidValidity, table.messageUid, table.attachmentIndex] }),
    index("idx_mail_attachments_user_message").on(table.userId, table.mailboxKey, table.uidValidity, table.messageUid),
  ],
);

export const mailIssues = sqliteTable(
  "mail_issues",
  {
    userId: text("user_id").notNull(),
    issueId: text("issue_id").notNull(),
    mailboxEmail: text("mailbox_email"),
    messageUid: integer("message_uid"),
    reasonCode: text("reason_code").notNull(),
    message: text("message").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.issueId] }),
    index("idx_mail_issues_user_created_at").on(table.userId, table.createdAt),
  ],
);

export const sharedMediaAssets = sqliteTable(
  "shared_media_assets",
  {
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(),
    schoolKey: text("school_key").notNull(),
    schoolName: text("school_name").notNull(),
    r2Key: text("r2_key").notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    submittedAt: text("submitted_at").notNull(),
    submissionId: text("submission_id").notNull(),
    uploadedAt: text("uploaded_at").notNull(),
    source: text("source").notNull().default("web"),
    sourceRef: text("source_ref"),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.kind, table.schoolKey] }),
    index("idx_shared_media_assets_user_kind_school_name").on(
      table.userId,
      table.kind,
      sql`${table.schoolName} COLLATE NOCASE`,
    ),
    check("chk_shared_media_assets_kind", sql`${table.kind} IN ('poster', 'video')`),
    check("chk_shared_media_assets_source", sql`${table.source} IN ('web', 'email')`),
    check(
      "chk_shared_media_assets_size",
      sql`${table.size} > 0 AND ${table.size} <= 209715200`,
    ),
  ],
);

export const mediaCollectorSettings = sqliteTable(
  "media_collector_settings",
  {
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(),
    startsAt: text("starts_at"),
    runTime: text("run_time").notNull().default("09:00"),
    timezone: text("timezone").notNull().default("Asia/Shanghai"),
    intervalMinutes: integer("interval_minutes").notNull().default(1440),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    nextRunAt: text("next_run_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.kind] }),
    check("chk_media_collector_settings_kind", sql`${table.kind} IN ('poster', 'video')`),
    index("idx_media_collector_settings_enabled_next_run")
      .on(table.enabled, table.nextRunAt)
      .where(sql`${table.enabled} = 1`),
  ],
);

export const mediaUploadSessions = sqliteTable(
  "media_upload_sessions",
  {
    userId: text("user_id").notNull(),
    sessionId: text("session_id").notNull(),
    kind: text("kind").notNull(),
    schoolKey: text("school_key").notNull(),
    schoolName: text("school_name").notNull(),
    filename: text("filename").notNull(),
    totalSize: integer("total_size").notNull(),
    submittedAt: text("submitted_at").notNull(),
    submissionId: text("submission_id").notNull(),
    tempR2Key: text("temp_r2_key").notNull(),
    r2UploadId: text("r2_upload_id").notNull(),
    partSize: integer("part_size").notNull(),
    contentType: text("content_type"),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.sessionId] }),
    check("chk_media_upload_sessions_kind", sql`${table.kind} IN ('poster', 'video')`),
    check("chk_media_upload_sessions_size", sql`${table.totalSize} > 0 AND ${table.totalSize} <= 209715200`),
    index("idx_media_upload_sessions_expires_at").on(table.expiresAt),
  ],
);

export const fankeConnectors = sqliteTable(
  "fanke_connectors",
  {
    userId: text("user_id").primaryKey(),
    formId: text("form_id"),
    secretHash: text("secret_hash").notNull().unique(),
    secretPrefix: text("secret_prefix").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    lastEventAt: text("last_event_at"),
    lastProcessedAt: text("last_processed_at"),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
);

export const fankeFiles = sqliteTable(
  "fanke_files",
  {
    userId: text("user_id").notNull(),
    queueId: text("queue_id").notNull(),
    formId: text("form_id"),
    submissionId: text("submission_id").notNull(),
    submittedAt: text("submitted_at").notNull(),
    schoolName: text("school_name").notNull(),
    fileId: text("file_id"),
    filename: text("filename").notNull(),
    downloadUrl: text("download_url").notNull(),
    size: integer("size"),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("pending"),
    source: text("source").notNull().default("webhook"),
    attemptCount: integer("attempt_count").notNull().default(0),
    claimToken: text("claim_token"),
    lastAttemptAt: text("last_attempt_at"),
    nextAttemptAt: text("next_attempt_at"),
    lastError: text("last_error"),
    receivedAt: text("received_at").notNull(),
    processedAt: text("processed_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.queueId] }),
    check("chk_fanke_files_kind", sql`${table.kind} IN ('registration','edp','poster','video')`),
    check("chk_fanke_files_status", sql`${table.status} IN ('pending','processing','retry','processed','ignored','invalid')`),
    index("idx_fanke_files_due").on(table.userId, table.kind, table.status, table.nextAttemptAt, table.receivedAt),
    index("idx_fanke_files_submission").on(table.userId, table.submissionId, table.kind),
  ],
);

export const fankeIssues = sqliteTable(
  "fanke_issues",
  {
    userId: text("user_id").notNull(),
    issueId: text("issue_id").notNull(),
    formId: text("form_id"),
    submissionId: text("submission_id"),
    schoolName: text("school_name"),
    reasonCode: text("reason_code").notNull(),
    message: text("message").notNull(),
    receivedAt: text("received_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.issueId] }),
    index("idx_fanke_issues_user_received").on(table.userId, table.receivedAt),
  ],
);

export const fankeAssistantSubmissions = sqliteTable(
  "fanke_assistant_submissions",
  {
    userId: text("user_id").notNull(),
    formId: text("form_id").notNull(),
    submissionId: text("submission_id").notNull(),
    revisionHash: text("revision_hash").notNull(),
    revisionNumber: integer("revision_number").notNull().default(1),
    submittedAt: text("submitted_at").notNull(),
    updatedAt: text("updated_at"),
    schoolName: text("school_name").notNull(),
    fileCount: integer("file_count").notNull().default(0),
    classifiedCount: integer("classified_count").notNull().default(0),
    firstSeenAt: text("first_seen_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    lastChangedAt: text("last_changed_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.formId, table.submissionId] }),
    index("idx_fanke_assistant_submissions_seen").on(table.userId, table.formId, table.lastSeenAt),
  ],
);

export const fankeAssistantFiles = sqliteTable(
  "fanke_assistant_files",
  {
    userId: text("user_id").notNull(),
    formId: text("form_id").notNull(),
    submissionId: text("submission_id").notNull(),
    fileKey: text("file_key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    fileId: text("file_id"),
    filename: text("filename").notNull(),
    downloadUrl: text("download_url").notNull(),
    size: integer("size"),
    context: text("context"),
    kind: text("kind"),
    lastSeenAt: text("last_seen_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.formId, table.submissionId, table.fileKey] }),
    check("chk_fanke_assistant_files_kind", sql`${table.kind} IS NULL OR ${table.kind} IN ('registration','edp','poster','video')`),
    index("idx_fanke_assistant_files_submission").on(table.userId, table.formId, table.submissionId),
  ],
);

export const fankeAssistantRuns = sqliteTable(
  "fanke_assistant_runs",
  {
    userId: text("user_id").primaryKey(),
    formId: text("form_id").notNull(),
    scanId: text("scan_id").notNull(),
    targetKind: text("target_kind").notNull().default("registration"),
    status: text("status").notNull().default("running"),
    totalRecords: integer("total_records").notNull().default(0),
    newRecords: integer("new_records").notNull().default(0),
    changedRecords: integer("changed_records").notNull().default(0),
    unchangedRecords: integer("unchanged_records").notNull().default(0),
    queuedFiles: integer("queued_files").notNull().default(0),
    unclassifiedFiles: integer("unclassified_files").notNull().default(0),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at"),
    lastError: text("last_error"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("chk_fanke_assistant_runs_status", sql`${table.status} IN ('running','completed','failed')`),
    check("chk_fanke_assistant_runs_target_kind", sql`${table.targetKind} IN ('registration','edp','poster','video')`),
  ],
);

export const mailMediaCandidates = sqliteTable(
  "mail_media_candidates",
  {
    userId: text("user_id").notNull(),
    candidateId: text("candidate_id").notNull(),
    mailboxKey: text("mailbox_key").notNull(),
    mailboxEmail: text("mailbox_email").notNull(),
    uidValidity: text("uid_validity").notNull(),
    messageUid: integer("message_uid").notNull(),
    attachmentIndex: integer("attachment_index").notNull(),
    kind: text("kind").notNull(),
    filename: text("filename").notNull(),
    subject: text("subject").notNull(),
    sender: text("sender"),
    receivedAt: text("received_at"),
    attachmentR2Key: text("attachment_r2_key").notNull(),
    status: text("status").notNull().default("pending"),
    reason: text("reason").notNull(),
    inferredSchoolName: text("inferred_school_name"),
    assignedSchoolName: text("assigned_school_name"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastAttemptAt: text("last_attempt_at"),
    assignedAt: text("assigned_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.candidateId] }),
    index("idx_mail_media_candidates_user_status_created").on(table.userId, table.status, table.createdAt),
    index("idx_mail_media_candidates_message").on(
      table.userId,
      table.mailboxKey,
      table.uidValidity,
      table.messageUid,
    ),
    check("chk_mail_media_candidates_kind", sql`${table.kind} IN ('poster', 'video')`),
    check(
      "chk_mail_media_candidates_status",
      sql`${table.status} IN ('pending', 'retry', 'processing', 'assigned', 'dismissed', 'invalid')`,
    ),
  ],
);

export const browserMailScanCheckpoints = sqliteTable(
  "browser_mail_scan_checkpoints",
  {
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(),
    mailboxKey: text("mailbox_key").notNull().default(""),
    lastMessageKey: text("last_message_key"),
    lastScanAt: text("last_scan_at"),
    lastError: text("last_error"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.kind] }),
    check("chk_browser_mail_scan_checkpoints_kind", sql`${table.kind} IN ('poster', 'video')`),
    index("idx_browser_mail_scan_checkpoints_updated").on(table.userId, table.updatedAt),
  ],
);

export const browserMailSeenAttachments = sqliteTable(
  "browser_mail_seen_attachments",
  {
    userId: text("user_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    kind: text("kind"),
    schoolName: text("school_name"),
    filename: text("filename").notNull(),
    size: integer("size").notNull(),
    receivedAt: text("received_at").notNull(),
    sourceRef: text("source_ref").notNull(),
    assetSchoolKey: text("asset_school_key"),
    status: text("status").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.fingerprint] }),
    check("chk_browser_mail_seen_attachments_kind", sql`${table.kind} IS NULL OR ${table.kind} IN ('poster', 'video')`),
    check("chk_browser_mail_seen_attachments_status", sql`${table.status} IN ('pending', 'uploaded', 'candidate', 'missing', 'invalid')`),
    check("chk_browser_mail_seen_attachments_size", sql`${table.size} >= 0`),
    index("idx_browser_mail_seen_status_received").on(table.userId, table.status, table.receivedAt),
  ],
);

export const edpReviewSettings = sqliteTable("edp_review_settings", {
  userId: text("user_id").primaryKey(),
  competitionYear: text("competition_year").notNull().default(""),
  safetyReviewerName: text("safety_reviewer_name").notNull().default(""),
  safetyReviewerEmail: text("safety_reviewer_email").notNull().default(""),
  expertMemberName: text("expert_member_name").notNull().default(""),
  expertMemberEmail: text("expert_member_email").notNull().default(""),
  templateVersion: text("template_version").notNull().default("v1"),
  activeRuleDocumentId: text("active_rule_document_id"),
  activeRuleVersion: text("active_rule_version"),
  updatedAt: text("updated_at").notNull(),
});

export const edpRuleDocuments = sqliteTable(
  "edp_rule_documents",
  {
    userId: text("user_id").notNull(),
    documentId: text("document_id").notNull(),
    applicableYear: integer("applicable_year").notNull(),
    enteredYear: integer("entered_year").notNull(),
    detectedYear: integer("detected_year"),
    filename: text("filename").notNull(),
    r2Key: text("r2_key").notNull(),
    sha256: text("sha256").notNull(),
    size: integer("size").notNull(),
    status: text("status").notNull().default("processing"),
    parseWarningsJson: text("parse_warnings_json").notNull().default("[]"),
    parseError: text("parse_error"),
    builtinRuleVersion: text("builtin_rule_version").notNull(),
    ruleVersion: text("rule_version").notNull(),
    yearConflictConfirmed: integer("year_conflict_confirmed", { mode: "boolean" }).notNull().default(false),
    confirmedAt: text("confirmed_at"),
    activatedAt: text("activated_at"),
    archivedAt: text("archived_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.documentId] }),
    check("chk_edp_rule_documents_year", sql`${table.applicableYear} BETWEEN 2000 AND 2200 AND ${table.enteredYear} BETWEEN 2000 AND 2200 AND (${table.detectedYear} IS NULL OR ${table.detectedYear} BETWEEN 2000 AND 2200)`),
    check("chk_edp_rule_documents_size", sql`${table.size} > 0 AND ${table.size} <= 52428800`),
    check("chk_edp_rule_documents_status", sql`${table.status} IN ('processing','needs_confirmation','active','archived','failed')`),
    check("chk_edp_rule_documents_sha256", sql`length(${table.sha256}) = 64`),
    check("chk_edp_rule_documents_year_conflict", sql`${table.yearConflictConfirmed} IN (0,1)`),
    uniqueIndex("uidx_edp_rule_documents_year_sha").on(table.userId, table.applicableYear, table.sha256),
    uniqueIndex("uidx_edp_rule_documents_active_year").on(table.userId, table.applicableYear).where(sql`${table.status} = 'active'`),
    index("idx_edp_rule_documents_year_status_created").on(table.userId, table.applicableYear, table.status, table.createdAt),
    index("idx_edp_rule_documents_rule_version").on(table.userId, table.ruleVersion),
  ],
);

export const edpRuleFacts = sqliteTable(
  "edp_rule_facts",
  {
    userId: text("user_id").notNull(),
    documentId: text("document_id").notNull(),
    factId: text("fact_id").notNull(),
    category: text("category").notNull(),
    section: text("section").notNull().default(""),
    normalizedRequirement: text("normalized_requirement").notNull(),
    operator: text("operator").notNull(),
    structuredValue: text("structured_value"),
    structuredUnit: text("structured_unit"),
    conditionText: text("condition_text"),
    sourcePage: integer("source_page").notNull(),
    evidenceExcerpt: text("evidence_excerpt").notNull(),
    confidence: text("confidence").notNull(),
    confirmationStatus: text("confirmation_status").notNull().default("pending"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.documentId, table.factId] }),
    check("chk_edp_rule_facts_category", sql`${table.category} IN ('numeric_limit','required','prohibited','allowed','conditional')`),
    check("chk_edp_rule_facts_operator", sql`${table.operator} IN ('lt','lte','eq','gte','gt','must','must_not','may','conditional')`),
    check("chk_edp_rule_facts_page", sql`${table.sourcePage} >= 1`),
    check("chk_edp_rule_facts_confidence", sql`${table.confidence} IN ('high','medium','low')`),
    check("chk_edp_rule_facts_confirmation", sql`${table.confirmationStatus} IN ('pending','confirmed','rejected')`),
    index("idx_edp_rule_facts_document_page").on(table.userId, table.documentId, table.sourcePage, table.factId),
  ],
);

export const edpReviewJobs = sqliteTable(
  "edp_review_jobs",
  {
    userId: text("user_id").notNull(),
    jobId: text("job_id").notNull(),
    schoolKey: text("school_key").notNull(),
    schoolName: text("school_name").notNull(),
    submissionId: text("submission_id").notNull(),
    submittedAt: text("submitted_at").notNull(),
    submissionRound: integer("submission_round").notNull(),
    sourceR2Key: text("source_r2_key"),
    sourceFilename: text("source_filename"),
    workName: text("work_name"),
    instructorName: text("instructor_name"),
    instructorEmail: text("instructor_email"),
    ruleVersion: text("rule_version").notNull(),
    templateVersion: text("template_version").notNull(),
    status: text("status").notNull().default("queued"),
    overallStatus: text("overall_status").notNull().default("pending"),
    supersededBy: text("superseded_by"),
    lastError: text("last_error"),
    reviewedAt: text("reviewed_at"),
    finalizedAt: text("finalized_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.jobId] }),
    check("chk_edp_review_jobs_round", sql`${table.submissionRound} BETWEEN 1 AND 5`),
    check("chk_edp_review_jobs_status", sql`${table.status} IN ('queued','processing','needs_human','ready','completed','failed','superseded')`),
    check("chk_edp_review_jobs_overall", sql`${table.overallStatus} IN ('pending','passed','failed','needs_human')`),
    uniqueIndex("uidx_edp_review_jobs_submission_rule").on(table.userId, table.schoolKey, table.submissionId, table.ruleVersion),
    index("idx_edp_review_jobs_school_updated").on(table.userId, table.schoolKey, table.updatedAt),
    index("idx_edp_review_jobs_status_updated").on(table.userId, table.status, table.updatedAt),
  ],
);

export const edpReviewItems = sqliteTable(
  "edp_review_items",
  {
    userId: text("user_id").notNull(),
    jobId: text("job_id").notNull(),
    ruleId: text("rule_id").notNull(),
    worksheetName: text("worksheet_name").notNull().default("2) EDP Evaluation"),
    templateRow: integer("template_row").notNull(),
    automaticStatus: text("automatic_status").notNull(),
    finalStatus: text("final_status").notNull(),
    suggestedComment: text("suggested_comment"),
    finalComment: text("final_comment"),
    evidenceJson: text("evidence_json").notNull().default("[]"),
    documentName: text("document_name"),
    pageNumber: integer("page_number"),
    isBlocking: integer("is_blocking", { mode: "boolean" }).notNull().default(true),
    ruleSource: text("rule_source").notNull().default("builtin:v1"),
    overrideActor: text("override_actor"),
    overridePreviousStatus: text("override_previous_status"),
    overriddenAt: text("overridden_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.jobId, table.ruleId] }),
    check("chk_edp_review_items_row", sql`${table.templateRow} BETWEEN 1 AND 1048576`),
    check("chk_edp_review_items_page", sql`${table.pageNumber} IS NULL OR ${table.pageNumber} >= 1`),
    check("chk_edp_review_items_blocking", sql`${table.isBlocking} IN (0,1)`),
    check("chk_edp_review_items_automatic_status", sql`${table.automaticStatus} IN ('yes','no','not_applicable','needs_human')`),
    check("chk_edp_review_items_final_status", sql`${table.finalStatus} IN ('yes','no','not_applicable','needs_human')`),
    check("chk_edp_review_items_previous_status", sql`${table.overridePreviousStatus} IS NULL OR ${table.overridePreviousStatus} IN ('yes','no','not_applicable','needs_human')`),
    index("idx_edp_review_items_job_status").on(table.userId, table.jobId, table.finalStatus, table.templateRow),
  ],
);

export const edpReviewExports = sqliteTable(
  "edp_review_exports",
  {
    userId: text("user_id").notNull(),
    jobId: text("job_id").notNull(),
    exportType: text("export_type").notNull(),
    r2Key: text("r2_key").notNull(),
    filename: text("filename").notNull(),
    size: integer("size").notNull(),
    ruleVersion: text("rule_version").notNull(),
    templateVersion: text("template_version").notNull(),
    submissionId: text("submission_id").notNull(),
    generatedAt: text("generated_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.jobId, table.exportType] }),
    check("chk_edp_review_exports_type", sql`${table.exportType} IN ('draft','final')`),
    check("chk_edp_review_exports_size", sql`${table.size} > 0`),
    index("idx_edp_review_exports_generated").on(table.userId, table.generatedAt),
  ],
);
