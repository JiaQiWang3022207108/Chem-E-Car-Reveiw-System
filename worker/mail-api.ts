import {
  AlibabaImapError,
  credentialKeyFromEnv,
  decryptCredential,
  encryptCredential,
  fetchAlibabaMailIncremental,
  testAlibabaMailConnection,
  type CollectedMailMessage,
  type PermanentMailMessageFailure,
} from "./mail-collector";
import {
  importStoredMediaAsset,
  MediaAssetApiError,
  validateMediaAssetSignature,
  type MediaAssetKind,
} from "./media-assets";

export interface MailEnv {
  DB: D1Database;
  FILES: R2Bucket;
  APP_CREDENTIAL_ENCRYPTION_KEY?: string;
}

interface MailSettingsRow {
  user_id: string;
  email: string;
  imap_host: string;
  imap_port: number;
  credential_ciphertext: string | null;
  starts_at: string | null;
  run_time: string;
  timezone: string;
  interval_minutes: number;
  enabled: number;
  next_run_at: string | null;
  uid_validity: string | null;
  last_uid: number;
  last_synced_at: string | null;
  last_sync_status: string;
  last_sync_error: string | null;
  sync_lock_token: string | null;
  sync_lock_until: string | null;
  updated_at: string;
}

interface MailMessageRow {
  mailbox_key: string;
  mailbox_email: string;
  uid_validity: string;
  message_uid: number;
  message_id: string | null;
  subject: string;
  from_name: string | null;
  from_address: string | null;
  received_at: string | null;
  raw_r2_key: string;
  raw_size: number;
  attachment_count: number;
  collected_at: string;
}

interface MailAttachmentRow {
  mailbox_key: string;
  uid_validity: string;
  message_uid: number;
  attachment_index: number;
  filename: string;
  content_type: string;
  size: number;
  r2_key: string;
  category: string;
  collected_at: string;
}

interface MailIssueRow {
  issue_id: string;
  mailbox_email: string | null;
  message_uid: number | null;
  reason_code: string;
  message: string;
  created_at: string;
}

type MailMediaCandidateStatus = "pending" | "retry" | "processing" | "assigned" | "dismissed" | "invalid";

interface MailMediaCandidateRow {
  candidate_id: string;
  mailbox_key: string;
  mailbox_email: string;
  uid_validity: string;
  message_uid: number;
  attachment_index: number;
  kind: MediaAssetKind;
  filename: string;
  subject: string;
  sender: string | null;
  received_at: string | null;
  attachment_r2_key: string;
  status: MailMediaCandidateStatus;
  reason: string;
  inferred_school_name: string | null;
  assigned_school_name: string | null;
  attempt_count: number;
  last_attempt_at: string | null;
  assigned_at: string | null;
  created_at: string;
  updated_at: string;
}

interface MailSchedule {
  startsAt: string | null;
  runTime: string;
  timezone: string;
  intervalMinutes: number;
  enabled: boolean;
  nextRunAt: string | null;
}

export interface MailDashboard {
  settings: ReturnType<typeof settingsFromRow>;
  messages: Array<Record<string, unknown>>;
  issues: Array<Record<string, unknown>>;
  nextCursor: string | null;
}

export class MailApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MailApiError";
  }
}

const ALIBABA_IMAP_HOST = "imap.qiye.aliyun.com";
const ALIBABA_IMAP_PORT = 993;
const MAX_SETTINGS_BODY_BYTES = 16 * 1024;
const MAX_SYNC_MESSAGES = 20;
const MAX_SYNC_BYTES = 48 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 24 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const LOCK_MINUTES = 15;
const BACKLOG_RETRY_MINUTES = 5;
const schemaPromises = new WeakMap<object, Promise<void>>();

const defaultSchedule: MailSchedule = {
  startsAt: null,
  runTime: "09:00",
  timezone: "Asia/Shanghai",
  intervalMinutes: 1440,
  enabled: false,
  nextRunAt: null,
};

function mailJson(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(data), { status, headers });
}

function methodNotAllowed(allowed: string[]): Response {
  return mailJson(
    { ok: false, error: { code: "method_not_allowed", message: `此接口仅支持 ${allowed.join("、")} 请求。` } },
    405,
    { Allow: allowed.join(", ") },
  );
}

function sanitizeMailError(error: unknown): MailApiError {
  if (error instanceof MailApiError) return error;
  if (error instanceof MediaAssetApiError) {
    return new MailApiError(error.status, error.code, error.message);
  }
  if (error instanceof AlibabaImapError) {
    switch (error.code) {
      case "AUTHENTICATION":
        return new MailApiError(422, "mail_authentication_failed", "阿里邮箱账号或第三方客户端安全密码验证失败。");
      case "CONFIGURATION":
        return new MailApiError(400, "mail_configuration_invalid", "阿里邮箱连接设置不正确，或服务器凭据加密尚未配置。");
      case "LIMIT_EXCEEDED":
        return new MailApiError(413, "mail_limit_exceeded", "本次邮件或附件超过安全收取上限，文件未完整收集。");
      case "MIME":
        return new MailApiError(422, "mail_mime_invalid", "邮件格式无法解析，或使用了不支持的传输编码。");
      case "CONNECT_TIMEOUT":
      case "TIMEOUT":
        return new MailApiError(504, "mail_connection_timeout", "连接阿里邮箱超时，请稍后重试。");
      case "CONNECTION":
      case "PROTOCOL":
        return new MailApiError(502, "mail_connection_failed", "暂时无法连接阿里邮箱 IMAP 服务。");
    }
  }
  return new MailApiError(500, "mail_internal_error", "服务器暂时无法完成邮件收取，请稍后重试。");
}

function responseFromError(error: unknown): Response {
  const safe = sanitizeMailError(error);
  return mailJson({ ok: false, error: { code: safe.code, message: safe.message } }, safe.status);
}

export async function ensureMailSchema(db: D1Database): Promise<void> {
  const cacheKey = db as unknown as object;
  const cached = schemaPromises.get(cacheKey);
  if (cached) return cached;
  const pending = (async () => {
    await db.batch([
      db.prepare(`
        CREATE TABLE IF NOT EXISTS mail_settings (
          user_id TEXT PRIMARY KEY NOT NULL,
          email TEXT NOT NULL DEFAULT '',
          imap_host TEXT NOT NULL DEFAULT 'imap.qiye.aliyun.com',
          imap_port INTEGER NOT NULL DEFAULT 993,
          credential_ciphertext TEXT,
          starts_at TEXT,
          run_time TEXT NOT NULL DEFAULT '09:00',
          timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
          interval_minutes INTEGER NOT NULL DEFAULT 1440,
          enabled INTEGER NOT NULL DEFAULT 0,
          next_run_at TEXT,
          uid_validity TEXT,
          last_uid INTEGER NOT NULL DEFAULT 0,
          last_synced_at TEXT,
          last_sync_status TEXT NOT NULL DEFAULT 'never',
          last_sync_error TEXT,
          sync_lock_token TEXT,
          sync_lock_until TEXT,
          updated_at TEXT NOT NULL
        )
      `),
      db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_mail_settings_enabled_next_run
        ON mail_settings (enabled, next_run_at)
        WHERE enabled = 1
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS mail_messages (
          user_id TEXT NOT NULL,
          mailbox_key TEXT NOT NULL,
          mailbox_email TEXT NOT NULL,
          uid_validity TEXT NOT NULL,
          message_uid INTEGER NOT NULL,
          message_id TEXT,
          subject TEXT NOT NULL,
          from_name TEXT,
          from_address TEXT,
          received_at TEXT,
          raw_r2_key TEXT NOT NULL,
          raw_size INTEGER NOT NULL,
          attachment_count INTEGER NOT NULL DEFAULT 0,
          collected_at TEXT NOT NULL,
          PRIMARY KEY (user_id, mailbox_key, uid_validity, message_uid)
        )
      `),
      db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_mail_messages_user_collected_at
        ON mail_messages (user_id, collected_at, message_uid, mailbox_key, uid_validity)
      `),
      db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_mail_messages_user_message_id
        ON mail_messages (user_id, message_id)
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS mail_attachments (
          user_id TEXT NOT NULL,
          mailbox_key TEXT NOT NULL,
          uid_validity TEXT NOT NULL,
          message_uid INTEGER NOT NULL,
          attachment_index INTEGER NOT NULL,
          filename TEXT NOT NULL,
          content_type TEXT NOT NULL,
          size INTEGER NOT NULL,
          r2_key TEXT NOT NULL,
          category TEXT NOT NULL DEFAULT 'other',
          collected_at TEXT NOT NULL,
          PRIMARY KEY (user_id, mailbox_key, uid_validity, message_uid, attachment_index)
        )
      `),
      db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_mail_attachments_user_message
        ON mail_attachments (user_id, mailbox_key, uid_validity, message_uid)
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS mail_issues (
          user_id TEXT NOT NULL,
          issue_id TEXT NOT NULL,
          mailbox_email TEXT,
          message_uid INTEGER,
          reason_code TEXT NOT NULL,
          message TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (user_id, issue_id)
        )
      `),
      db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_mail_issues_user_created_at
        ON mail_issues (user_id, created_at)
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS mail_media_candidates (
          user_id TEXT NOT NULL,
          candidate_id TEXT NOT NULL,
          mailbox_key TEXT NOT NULL,
          mailbox_email TEXT NOT NULL,
          uid_validity TEXT NOT NULL,
          message_uid INTEGER NOT NULL,
          attachment_index INTEGER NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('poster', 'video')),
          filename TEXT NOT NULL,
          subject TEXT NOT NULL,
          sender TEXT,
          received_at TEXT,
          attachment_r2_key TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (
            status IN ('pending', 'retry', 'processing', 'assigned', 'dismissed', 'invalid')
          ),
          reason TEXT NOT NULL,
          inferred_school_name TEXT,
          assigned_school_name TEXT,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          last_attempt_at TEXT,
          assigned_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (user_id, candidate_id)
        )
      `),
      db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_mail_media_candidates_user_status_created
        ON mail_media_candidates (user_id, status, created_at)
      `),
      db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_mail_media_candidates_message
        ON mail_media_candidates (user_id, mailbox_key, uid_validity, message_uid)
      `),
    ]);
    await db.prepare("PRAGMA optimize").run();
  })();
  schemaPromises.set(cacheKey, pending);
  try {
    await pending;
  } catch (error) {
    schemaPromises.delete(cacheKey);
    throw error;
  }
}

function settingsFromRow(row: MailSettingsRow | null) {
  return {
    email: row?.email ?? "",
    imapHost: row?.imap_host ?? ALIBABA_IMAP_HOST,
    imapPort: row?.imap_port ?? ALIBABA_IMAP_PORT,
    credentialConfigured: Boolean(row?.credential_ciphertext),
    startsAt: row?.starts_at ?? defaultSchedule.startsAt,
    runTime: row?.run_time ?? defaultSchedule.runTime,
    timezone: row?.timezone ?? defaultSchedule.timezone,
    intervalMinutes: row?.interval_minutes ?? defaultSchedule.intervalMinutes,
    enabled: row?.enabled === 1,
    nextRunAt: row?.next_run_at ?? null,
    lastSyncAt: row?.last_synced_at ?? null,
    lastSyncStatus: row?.last_sync_status ?? "never",
    lastSyncError: row?.last_sync_error ?? null,
  };
}

async function getSettingsRow(db: D1Database, userId: string): Promise<MailSettingsRow | null> {
  return db.prepare(`
    SELECT user_id, email, imap_host, imap_port, credential_ciphertext, starts_at, run_time,
           timezone, interval_minutes, enabled, next_run_at, uid_validity, last_uid,
           last_synced_at, last_sync_status, last_sync_error, sync_lock_token,
           sync_lock_until, updated_at
    FROM mail_settings
    WHERE user_id = ?
  `).bind(userId).first<MailSettingsRow>();
}

function safeSegment(value: string, pattern: RegExp, label: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new MailApiError(400, "invalid_download_path", `${label} 无法识别。`);
  }
  if (!pattern.test(decoded)) throw new MailApiError(400, "invalid_download_path", `${label} 格式不正确。`);
  return decoded;
}

function messageKey(mailboxKey: string, uidValidity: string, messageUid: number): string {
  return `${mailboxKey}:${uidValidity}:${messageUid}`;
}

function attachmentCategory(filename: string, subject: string): string {
  const extension = filename.split(".").pop()?.toLocaleLowerCase("en-US") ?? "";
  if (extension === "xlsx") return "registration";
  const mediaKind = mediaKindForFilename(filename, subject);
  if (mediaKind) return mediaKind;
  if (extension === "zip") return "edp";
  return "other";
}

function mediaKindForFilename(filename: string, subject = ""): MediaAssetKind | null {
  const extension = filename.split(".").pop()?.toLocaleLowerCase("en-US") ?? "";
  if (["ai", "jpg", "jpeg"].includes(extension)) return "poster";
  if (extension === "mp4") return "video";
  if (["zip", "7z", "rar"].includes(extension)) {
    const text = normalizedSearchText(`${subject} ${filename.replace(/\.[^.]+$/u, "")}`);
    const poster = /海报|poster/iu.test(text);
    const video = /视频|video/iu.test(text);
    if (poster !== video) return poster ? "poster" : "video";
  }
  return null;
}

function normalizedSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN");
}

function patternedSchoolNames(subject: string, filename: string): string[] {
  const boundary = String.raw`[\s_\-—–|｜/\\:：,，;；()（）\[\]【】]`;
  const texts = [subject, filename.replace(/\.[^.]+$/u, "")];
  const found = new Set<string>();
  const blockedEnglish = /\b(?:poster|video|submission|attachment|from|fwd|re)\b/iu;
  for (const text of texts) {
    const chinese = new RegExp(`(?:^|${boundary})([\\p{Script=Han}]{2,24}(?:大学|学院))(?=$|${boundary})`, "gu");
    for (const match of text.matchAll(chinese)) {
      const value = match[1]?.trim();
      if (value && !/^(?:关于|来自|提交|报名|海报|视频|参赛|附件)/u.test(value)) found.add(value);
    }
    const english = new RegExp(
      `(?:^|${boundary})([A-Z][A-Za-z&.'’ -]{1,70}?(?:University|College|Institute))(?=$|${boundary})`,
      "gu",
    );
    for (const match of text.matchAll(english)) {
      const value = match[1]?.replace(/\s+/gu, " ").trim();
      if (value && !blockedEnglish.test(value)) found.add(value);
    }
  }
  return [...found];
}

async function knownSchoolNames(db: D1Database, userId: string): Promise<string[]> {
  const queries = [
    "SELECT school_name FROM collector_registrations WHERE user_id = ?",
    "SELECT school_name FROM edp_submissions WHERE user_id = ?",
    "SELECT school_name FROM shared_media_assets WHERE user_id = ?",
  ];
  const results = await Promise.allSettled(
    queries.map((query) => db.prepare(query).bind(userId).all<{ school_name: string }>()),
  );
  const names = new Map<string, string>();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const row of result.value.results) {
      const schoolName = row.school_name?.normalize("NFKC").replace(/\s+/gu, " ").trim();
      if (schoolName) names.set(normalizedSearchText(schoolName), schoolName);
    }
  }
  return [...names.values()];
}

async function inferSchoolName(
  db: D1Database,
  userId: string,
  subject: string,
  filename: string,
): Promise<{ schoolName: string | null; reason: string }> {
  const haystack = normalizedSearchText(`${subject}\n${filename}`);
  const known = (await knownSchoolNames(db, userId)).filter((name) => haystack.includes(normalizedSearchText(name)));
  if (known.length === 1) return { schoolName: known[0], reason: "known_school_unique_match" };
  if (known.length > 1) return { schoolName: null, reason: "multiple_known_schools_matched" };
  const patterned = patternedSchoolNames(subject, filename);
  if (patterned.length === 1) return { schoolName: patterned[0], reason: "explicit_school_name_match" };
  if (patterned.length > 1) return { schoolName: null, reason: "multiple_school_names_matched" };
  return { schoolName: null, reason: "school_confirmation_required" };
}

function senderLabel(row: MailMessageRow): string {
  if (row.from_name && row.from_address) return `${row.from_name} <${row.from_address}>`;
  return row.from_address || row.from_name || "未知发件人";
}

function shapeMailMessages(
  messageRows: MailMessageRow[],
  attachmentRows: MailAttachmentRow[],
): Array<Record<string, unknown>> {
  const attachmentsByMessage = new Map<string, Array<Record<string, unknown>>>();
  for (const row of attachmentRows) {
    const key = messageKey(row.mailbox_key, row.uid_validity, row.message_uid);
    const list = attachmentsByMessage.get(key) ?? [];
    list.push({
      id: `${key}:${row.attachment_index}`,
      filename: row.filename,
      contentType: row.content_type,
      size: row.size,
      category: row.category,
      collectedAt: row.collected_at,
      downloadUrl: `/api/mail-attachments/${encodeURIComponent(row.mailbox_key)}/${encodeURIComponent(row.uid_validity)}/${row.message_uid}/${row.attachment_index}/download`,
      deleteUrl: `/api/mail-attachments/${encodeURIComponent(row.mailbox_key)}/${encodeURIComponent(row.uid_validity)}/${row.message_uid}/${row.attachment_index}`,
    });
    attachmentsByMessage.set(key, list);
  }

  return messageRows.map((row) => {
    const key = messageKey(row.mailbox_key, row.uid_validity, row.message_uid);
    return {
      id: key,
      messageId: row.message_id ?? key,
      mailboxEmail: row.mailbox_email,
      subject: row.subject || "（无主题）",
      sender: senderLabel(row),
      from: senderLabel(row),
      receivedAt: row.received_at,
      createdAt: row.collected_at,
      size: row.raw_size,
      attachments: attachmentsByMessage.get(key) ?? [],
      rawDownloadUrl: `/api/mail-messages/${encodeURIComponent(row.mailbox_key)}/${encodeURIComponent(row.uid_validity)}/${row.message_uid}/download`,
    };
  });
}

export async function getMailDashboard(env: MailEnv, userId: string): Promise<MailDashboard> {
  await ensureMailSchema(env.DB);
  const [settingsRow, messagesResult, attachmentsResult, issuesResult] = await Promise.all([
    getSettingsRow(env.DB, userId),
    env.DB.prepare(`
      SELECT mailbox_key, mailbox_email, uid_validity, message_uid, message_id, subject,
             from_name, from_address, received_at, raw_r2_key, raw_size,
             attachment_count, collected_at
      FROM mail_messages
      WHERE user_id = ?
      ORDER BY collected_at DESC, message_uid DESC, mailbox_key DESC, uid_validity DESC
      LIMIT 51
    `).bind(userId).all<MailMessageRow>(),
    env.DB.prepare(`
      SELECT a.mailbox_key, a.uid_validity, a.message_uid, a.attachment_index,
             a.filename, a.content_type, a.size, a.r2_key, a.category, a.collected_at
      FROM mail_attachments AS a
      INNER JOIN (
        SELECT mailbox_key, uid_validity, message_uid
        FROM mail_messages
        WHERE user_id = ?
        ORDER BY collected_at DESC, message_uid DESC, mailbox_key DESC, uid_validity DESC
        LIMIT 50
      ) AS recent
        ON recent.mailbox_key = a.mailbox_key
       AND recent.uid_validity = a.uid_validity
       AND recent.message_uid = a.message_uid
      WHERE a.user_id = ?
      ORDER BY a.message_uid DESC, a.attachment_index ASC
    `).bind(userId, userId).all<MailAttachmentRow>(),
    env.DB.prepare(`
      SELECT issue_id, mailbox_email, message_uid, reason_code, message, created_at
      FROM mail_issues
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 50
    `).bind(userId).all<MailIssueRow>(),
  ]);

  const visibleRows = messagesResult.results.slice(0, 50);
  const messages = shapeMailMessages(visibleRows, attachmentsResult.results);

  return {
    settings: settingsFromRow(settingsRow),
    messages,
    nextCursor: messagesResult.results.length > 50 && visibleRows.length > 0
      ? encodeMailCursor(visibleRows[visibleRows.length - 1])
      : null,
    issues: issuesResult.results.map((row) => ({
      id: row.issue_id,
      messageId: row.message_uid === null ? undefined : String(row.message_uid),
      mailboxEmail: row.mailbox_email,
      reasonCode: row.reason_code,
      reason: row.message,
      message: row.message,
      createdAt: row.created_at,
    })),
  };
}

interface MailPageCursor {
  version: 1;
  collectedAt: string;
  messageUid: number;
  mailboxKey: string;
  uidValidity: string;
}

function encodeMailCursor(row: MailMessageRow): string {
  const bytes = new TextEncoder().encode(JSON.stringify({
    version: 1,
    collectedAt: row.collected_at,
    messageUid: row.message_uid,
    mailboxKey: row.mailbox_key,
    uidValidity: row.uid_validity,
  } satisfies MailPageCursor));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeMailCursor(value: string): MailPageCursor {
  if (value.length < 1 || value.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new MailApiError(400, "invalid_mail_cursor", "邮件分页游标格式不正确。");
  }
  try {
    const standard = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, "="));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Partial<MailPageCursor>;
    if (
      parsed.version !== 1
      || typeof parsed.collectedAt !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(parsed.collectedAt)
      || !Number.isSafeInteger(parsed.messageUid)
      || (parsed.messageUid ?? 0) < 1
      || typeof parsed.mailboxKey !== "string"
      || !/^[a-f0-9]{32}$/u.test(parsed.mailboxKey)
      || typeof parsed.uidValidity !== "string"
      || !/^[A-Za-z0-9._-]{1,80}$/u.test(parsed.uidValidity)
    ) {
      throw new Error("invalid cursor fields");
    }
    return parsed as MailPageCursor;
  } catch (error) {
    if (error instanceof MailApiError) throw error;
    throw new MailApiError(400, "invalid_mail_cursor", "邮件分页游标格式不正确。");
  }
}

function pageCursorSql(cursor: MailPageCursor | null): { clause: string; values: unknown[] } {
  if (!cursor) return { clause: "", values: [] };
  return {
    clause: `
      AND (
        collected_at < ?
        OR (collected_at = ? AND message_uid < ?)
        OR (collected_at = ? AND message_uid = ? AND mailbox_key < ?)
        OR (collected_at = ? AND message_uid = ? AND mailbox_key = ? AND uid_validity < ?)
      )
    `,
    values: [
      cursor.collectedAt,
      cursor.collectedAt,
      cursor.messageUid,
      cursor.collectedAt,
      cursor.messageUid,
      cursor.mailboxKey,
      cursor.collectedAt,
      cursor.messageUid,
      cursor.mailboxKey,
      cursor.uidValidity,
    ],
  };
}

/** Authenticated, stable keyset pagination for complete shared mail history. */
export async function listMailMessagesPage(
  request: Request,
  env: MailEnv,
  userId: string,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  try {
    await ensureMailSchema(env.DB);
    const url = new URL(request.url);
    const limitValue = url.searchParams.get("limit") ?? "50";
    if (!/^\d{1,3}$/u.test(limitValue)) {
      throw new MailApiError(400, "invalid_mail_page_limit", "邮件分页数量必须是 1 到 100 的整数。");
    }
    const limit = Number(limitValue);
    if (limit < 1 || limit > 100) {
      throw new MailApiError(400, "invalid_mail_page_limit", "邮件分页数量必须是 1 到 100 的整数。");
    }
    const cursorValue = url.searchParams.get("cursor");
    const cursor = cursorValue ? decodeMailCursor(cursorValue) : null;
    const page = pageCursorSql(cursor);
    const messageRows = await env.DB.prepare(`
      SELECT mailbox_key, mailbox_email, uid_validity, message_uid, message_id, subject,
             from_name, from_address, received_at, raw_r2_key, raw_size,
             attachment_count, collected_at
      FROM mail_messages
      WHERE user_id = ? ${page.clause}
      ORDER BY collected_at DESC, message_uid DESC, mailbox_key DESC, uid_validity DESC
      LIMIT ?
    `).bind(userId, ...page.values, limit + 1).all<MailMessageRow>();
    const visibleRows = messageRows.results.slice(0, limit);

    let attachmentRows: MailAttachmentRow[] = [];
    if (visibleRows.length > 0) {
      const attachmentResult = await env.DB.prepare(`
        WITH page AS (
          SELECT mailbox_key, uid_validity, message_uid
          FROM mail_messages
          WHERE user_id = ? ${page.clause}
          ORDER BY collected_at DESC, message_uid DESC, mailbox_key DESC, uid_validity DESC
          LIMIT ?
        )
        SELECT a.mailbox_key, a.uid_validity, a.message_uid, a.attachment_index,
               a.filename, a.content_type, a.size, a.r2_key, a.category, a.collected_at
        FROM mail_attachments AS a
        INNER JOIN page
          ON page.mailbox_key = a.mailbox_key
         AND page.uid_validity = a.uid_validity
         AND page.message_uid = a.message_uid
        WHERE a.user_id = ?
        ORDER BY a.message_uid DESC, a.attachment_index ASC
      `).bind(userId, ...page.values, limit, userId).all<MailAttachmentRow>();
      attachmentRows = attachmentResult.results;
    }

    const hasNext = messageRows.results.length > limit;
    const last = visibleRows.at(-1);
    return mailJson({
      ok: true,
      messages: shapeMailMessages(visibleRows, attachmentRows),
      nextCursor: hasNext && last ? encodeMailCursor(last) : null,
    });
  } catch (error) {
    return responseFromError(error);
  }
}

export async function listMailMediaCandidates(
  request: Request,
  env: MailEnv,
  userId: string,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  try {
    await ensureMailSchema(env.DB);
    const url = new URL(request.url);
    const requestedStatus = url.searchParams.get("status") ?? "action";
    const allowed = new Set(["action", "all", "pending", "retry", "processing", "assigned", "dismissed", "invalid"]);
    if (!allowed.has(requestedStatus)) {
      throw new MailApiError(400, "invalid_candidate_status", "候选状态筛选值不正确。");
    }
    const rawLimit = url.searchParams.get("limit") ?? "100";
    if (!/^\d{1,3}$/u.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 100) {
      throw new MailApiError(400, "invalid_candidate_limit", "候选列表数量必须是 1 到 100 的整数。");
    }
    const statusClause = requestedStatus === "all"
      ? ""
      : requestedStatus === "action"
        ? "AND status IN ('pending', 'retry', 'processing', 'invalid')"
        : "AND status = ?";
    const bindings: Array<string | number> = [userId];
    if (!['all', 'action'].includes(requestedStatus)) bindings.push(requestedStatus);
    bindings.push(Number(rawLimit));
    const [candidates, counts] = await Promise.all([
      env.DB.prepare(`
        SELECT ${candidateColumns}
        FROM mail_media_candidates
        WHERE user_id = ? ${statusClause}
        ORDER BY
          CASE status WHEN 'pending' THEN 0 WHEN 'invalid' THEN 1 WHEN 'retry' THEN 2 ELSE 3 END,
          created_at DESC
        LIMIT ?
      `).bind(...bindings).all<MailMediaCandidateRow>(),
      env.DB.prepare(`
        SELECT status, COUNT(*) AS count
        FROM mail_media_candidates
        WHERE user_id = ?
        GROUP BY status
      `).bind(userId).all<{ status: MailMediaCandidateStatus; count: number }>(),
    ]);
    const countMap: Record<string, number> = {};
    for (const row of counts.results) countMap[row.status] = Number(row.count);
    return mailJson({
      ok: true,
      candidates: candidates.results.map(candidateFromRow),
      counts: {
        pending: countMap.pending ?? 0,
        retry: countMap.retry ?? 0,
        processing: countMap.processing ?? 0,
        invalid: countMap.invalid ?? 0,
        assigned: countMap.assigned ?? 0,
        dismissed: countMap.dismissed ?? 0,
      },
      filter: requestedStatus,
    });
  } catch (error) {
    return responseFromError(error);
  }
}

export async function assignMailMediaCandidate(
  request: Request,
  env: MailEnv,
  userId: string,
  candidateIdValue: string,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  try {
    await ensureMailSchema(env.DB);
    const candidateId = candidateIdValue.toLocaleLowerCase("en-US");
    if (!/^[a-f0-9]{64}$/u.test(candidateId)) {
      throw new MailApiError(400, "invalid_mail_media_candidate_id", "邮件媒体候选标识格式不正确。");
    }
    const body = await readLimitedJson(request);
    if (typeof body.schoolName !== "string") {
      throw new MailApiError(400, "school_name_required", "请提供要归入的学校名称 schoolName。");
    }
    const result = await processMailMediaCandidate(env, userId, candidateId, body.schoolName);
    return mailJson({ ok: true, ...result });
  } catch (error) {
    return responseFromError(error);
  }
}

async function readLimitedJson(request: Request): Promise<Record<string, unknown>> {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength && Number(contentLength) > MAX_SETTINGS_BODY_BYTES) {
    throw new MailApiError(413, "settings_body_too_large", "邮箱设置内容过大。");
  }
  if (!request.body) throw new MailApiError(400, "invalid_settings", "缺少邮箱设置。");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_SETTINGS_BODY_BYTES) {
        await reader.cancel();
        throw new MailApiError(413, "settings_body_too_large", "邮箱设置内容过大。");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("shape");
    return parsed as Record<string, unknown>;
  } catch {
    throw new MailApiError(400, "invalid_settings", "邮箱设置必须是有效的 JSON 对象。");
  }
}

function normalizedEmail(value: unknown): string {
  if (typeof value !== "string") throw new MailApiError(400, "invalid_email", "请填写阿里邮箱账号。");
  const email = value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  if (email.length > 254 || !/^[^\s@\0\r\n]+@[^\s@\0\r\n]+\.[^\s@\0\r\n]+$/u.test(email)) {
    throw new MailApiError(400, "invalid_email", "阿里邮箱账号格式不正确。");
  }
  return email;
}

function parseDateOnly(value: unknown): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value.trim())) {
    throw new MailApiError(400, "invalid_mail_schedule", "开始日期格式不正确。");
  }
  const input = value.trim();
  const [year, month, day] = input.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new MailApiError(400, "invalid_mail_schedule", "开始日期不是有效日期。");
  }
  return input;
}

function parseRunTime(value: unknown): string {
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value.trim())) {
    throw new MailApiError(400, "invalid_mail_schedule", "执行时间必须使用 HH:MM 格式。");
  }
  return value.trim();
}

function parseTimezone(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 100) {
    throw new MailApiError(400, "invalid_mail_schedule", "时区格式不正确。");
  }
  const timezone = value.trim();
  try {
    new Intl.DateTimeFormat("zh-CN", { timeZone: timezone }).format();
  } catch {
    throw new MailApiError(400, "invalid_mail_schedule", "时区不是有效时区。");
  }
  return timezone;
}

function zonedStartTimestamp(startsAt: string, runTime: string, timezone: string): number {
  const [year, month, day] = startsAt.split("-").map(Number);
  const [hour, minute] = runTime.split(":").map(Number);
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  let candidate = desired;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(candidate)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
    );
    const rendered = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second),
    );
    const correction = desired - rendered;
    candidate += correction;
    if (correction === 0) break;
  }
  return candidate;
}

function calculateNextRunAt(schedule: MailSchedule, now = Date.now()): string | null {
  if (!schedule.enabled || !schedule.startsAt) return null;
  const firstRun = zonedStartTimestamp(schedule.startsAt, schedule.runTime, schedule.timezone);
  const intervalMs = schedule.intervalMinutes * 60_000;
  if (firstRun > now) return new Date(firstRun).toISOString();
  const elapsedIntervals = Math.floor((now - firstRun) / intervalMs) + 1;
  return new Date(firstRun + elapsedIntervals * intervalMs).toISOString();
}

export async function updateMailSettings(request: Request, env: MailEnv, userId: string): Promise<Response> {
  if (request.method !== "PUT") return methodNotAllowed(["PUT"]);
  try {
    await ensureMailSchema(env.DB);
    const body = await readLimitedJson(request);
    const existing = await getSettingsRow(env.DB, userId);
    const email = normalizedEmail(body.email);
    const imapHost = typeof body.imapHost === "string" ? body.imapHost.trim().toLocaleLowerCase("en-US") : ALIBABA_IMAP_HOST;
    const imapPort = Number(body.imapPort ?? ALIBABA_IMAP_PORT);
    if (imapHost !== ALIBABA_IMAP_HOST || imapPort !== ALIBABA_IMAP_PORT) {
      throw new MailApiError(400, "unsupported_imap_endpoint", "目前仅支持阿里邮箱加密 IMAP：imap.qiye.aliyun.com:993。");
    }
    const startsAt = parseDateOnly(body.startsAt ?? null);
    const runTime = parseRunTime(body.runTime);
    const timezone = parseTimezone(body.timezone);
    const intervalMinutes = Number(body.intervalMinutes);
    if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < 60 || intervalMinutes > 525600) {
      throw new MailApiError(400, "invalid_mail_schedule", "收取频率必须在 1 小时至 1 年之间。");
    }
    if (typeof body.enabled !== "boolean") throw new MailApiError(400, "invalid_mail_schedule", "enabled 必须为布尔值。");
    const enabled = body.enabled;
    if (enabled && !startsAt) throw new MailApiError(400, "invalid_mail_schedule", "启用定时收取前必须设置开始日期。");

    const mailboxChanged = Boolean(existing && existing.email && existing.email !== email);
    const collectionBoundaryChanged = mailboxChanged || Boolean(existing && existing.starts_at !== startsAt);
    let credentialCiphertext = existing?.credential_ciphertext ?? null;
    if (mailboxChanged && body.securityPassword === undefined) {
      throw new MailApiError(400, "mail_password_required_for_new_account", "更换邮箱账号时，请同时填写该账号的新第三方客户端安全密码。");
    }
    if (body.securityPassword !== undefined) {
      if (typeof body.securityPassword !== "string" || body.securityPassword.length < 1 || body.securityPassword.length > 256 || /[\r\n\0]/u.test(body.securityPassword)) {
        throw new MailApiError(400, "invalid_mail_password", "第三方客户端安全密码格式不正确。");
      }
      credentialCiphertext = await encryptCredential(body.securityPassword, credentialKeyFromEnv(env));
    }
    if (enabled && !credentialCiphertext) {
      throw new MailApiError(400, "mail_password_required", "首次启用邮箱收取时，请填写第三方客户端安全密码。");
    }

    const schedule: MailSchedule = { startsAt, runTime, timezone, intervalMinutes, enabled, nextRunAt: null };
    schedule.nextRunAt = calculateNextRunAt(schedule);
    const now = new Date().toISOString();
    const savedRow = await env.DB.prepare(`
      INSERT INTO mail_settings (
        user_id, email, imap_host, imap_port, credential_ciphertext, starts_at, run_time,
        timezone, interval_minutes, enabled, next_run_at, uid_validity, last_uid,
        last_synced_at, last_sync_status, last_sync_error, sync_lock_token,
        sync_lock_until, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        email = excluded.email,
        imap_host = excluded.imap_host,
        imap_port = excluded.imap_port,
        credential_ciphertext = excluded.credential_ciphertext,
        starts_at = excluded.starts_at,
        run_time = excluded.run_time,
        timezone = excluded.timezone,
        interval_minutes = excluded.interval_minutes,
        enabled = excluded.enabled,
        next_run_at = excluded.next_run_at,
        uid_validity = excluded.uid_validity,
        last_uid = excluded.last_uid,
        last_synced_at = excluded.last_synced_at,
        last_sync_status = excluded.last_sync_status,
        last_sync_error = excluded.last_sync_error,
        sync_lock_token = NULL,
        sync_lock_until = NULL,
        updated_at = excluded.updated_at
      WHERE mail_settings.sync_lock_until IS NULL OR mail_settings.sync_lock_until <= ?
      RETURNING user_id
    `).bind(
      userId,
      email,
      imapHost,
      imapPort,
      credentialCiphertext,
      startsAt,
      runTime,
      timezone,
      intervalMinutes,
      enabled ? 1 : 0,
      schedule.nextRunAt,
      collectionBoundaryChanged ? null : existing?.uid_validity ?? null,
      collectionBoundaryChanged ? 0 : existing?.last_uid ?? 0,
      collectionBoundaryChanged ? null : existing?.last_synced_at ?? null,
      collectionBoundaryChanged ? "never" : existing?.last_sync_status ?? "never",
      collectionBoundaryChanged ? null : existing?.last_sync_error ?? null,
      now,
      now,
    ).first<{ user_id: string }>();
    if (!savedRow) {
      throw new MailApiError(409, "mail_sync_in_progress", "邮箱正在收取邮件，请等待本次收取完成后再保存设置。");
    }
    const saved = await getSettingsRow(env.DB, userId);
    return mailJson({ ok: true, settings: settingsFromRow(saved), mailSettings: settingsFromRow(saved) });
  } catch (error) {
    return responseFromError(error);
  }
}

async function configuredCredential(env: MailEnv, row: MailSettingsRow | null): Promise<string> {
  if (!row?.email || !row.credential_ciphertext) {
    throw new MailApiError(400, "mail_not_configured", "请先保存阿里邮箱账号和第三方客户端安全密码。");
  }
  return decryptCredential(row.credential_ciphertext, credentialKeyFromEnv(env));
}

export async function testMailSettings(request: Request, env: MailEnv, userId: string): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  try {
    await ensureMailSchema(env.DB);
    const row = await getSettingsRow(env.DB, userId);
    const password = await configuredCredential(env, row);
    await testAlibabaMailConnection({
      email: row!.email,
      password,
      host: row!.imap_host,
      port: row!.imap_port,
      timeoutMs: 20_000,
    });
    return mailJson({ ok: true, message: "阿里邮箱连接成功，可以安全收取邮件。" });
  } catch (error) {
    return responseFromError(error);
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeFilename(value: string): string {
  const normalized = Array.from(value.normalize("NFKC"), (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127 || character === "\\" || character === "/" ? "_" : character;
  }).join("");
  return normalized.trim().slice(0, 240) || "attachment.bin";
}

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[\r\n"]/gu, "_").replace(/[^\x20-\x7E]/gu, "_") || "download";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function putMessage(
  env: MailEnv,
  userId: string,
  lockToken: string,
  mailboxKey: string,
  mailboxEmail: string,
  uidValidity: string,
  message: CollectedMailMessage,
): Promise<void> {
  const userKey = (await sha256Hex(`chemecar-mail-user-v1:${userId}`)).slice(0, 32);
  const base = `users/${userKey}/mail/${mailboxKey}/${encodeURIComponent(uidValidity)}/${message.uid}`;
  const rawKey = `${base}/message.eml`;
  const collectedAt = new Date().toISOString();
  await env.FILES.put(rawKey, message.rawBytes, {
    httpMetadata: { contentType: "message/rfc822" },
    customMetadata: { mailboxKey, uidValidity, messageUid: String(message.uid) },
  });

  const attachmentRows: Array<{
    index: number;
    filename: string;
    contentType: string;
    size: number;
    r2Key: string;
    category: string;
  }> = [];
  for (let index = 0; index < message.attachments.length; index += 1) {
    const attachment = message.attachments[index];
    const filename = safeFilename(attachment.filename);
    const r2Key = `${base}/attachment-${String(index).padStart(3, "0")}`;
    await env.FILES.put(r2Key, attachment.bytes, {
      httpMetadata: { contentType: attachment.contentType || "application/octet-stream" },
      customMetadata: { filename, mailboxKey, uidValidity, messageUid: String(message.uid) },
    });
    attachmentRows.push({
      index,
      filename,
      contentType: attachment.contentType || "application/octet-stream",
      size: attachment.bytes.byteLength,
      r2Key,
      category: attachmentCategory(filename, message.subject),
    });
  }

  const sender = message.fromName && message.fromAddress
    ? `${message.fromName} <${message.fromAddress}>`
    : message.fromAddress || message.fromName || null;
  const mediaCandidates: Array<{
    id: string;
    kind: MediaAssetKind;
    attachmentIndex: number;
    filename: string;
    r2Key: string;
    status: MailMediaCandidateStatus;
    reason: string;
    inferredSchoolName: string | null;
  }> = [];
  for (const attachmentRow of attachmentRows) {
    const kind = mediaKindForFilename(attachmentRow.filename, message.subject);
    if (!kind) continue;
    const attachment = message.attachments[attachmentRow.index];
    const candidateId = await sha256Hex(
      `chemecar-mail-media-v1:${userId}:${mailboxKey}:${uidValidity}:${message.uid}:${attachmentRow.index}`,
    );
    let status: MailMediaCandidateStatus = "pending";
    let reason = "school_confirmation_required";
    let inferredSchoolName: string | null = null;
    try {
      validateMediaAssetSignature(kind, attachmentRow.filename, attachment.bytes);
      const inference = await inferSchoolName(env.DB, userId, message.subject, attachmentRow.filename);
      inferredSchoolName = inference.schoolName;
      reason = inference.reason;
      if (inferredSchoolName) status = "retry";
    } catch (error) {
      if (!(error instanceof MediaAssetApiError)) throw error;
      status = "invalid";
      reason = error.code;
    }
    mediaCandidates.push({
      id: candidateId,
      kind,
      attachmentIndex: attachmentRow.index,
      filename: attachmentRow.filename,
      r2Key: attachmentRow.r2Key,
      status,
      reason,
      inferredSchoolName,
    });
  }

  const statements = [
    env.DB.prepare(`
      INSERT INTO mail_messages (
        user_id, mailbox_key, mailbox_email, uid_validity, message_uid, message_id,
        subject, from_name, from_address, received_at, raw_r2_key, raw_size,
        attachment_count, collected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, mailbox_key, uid_validity, message_uid) DO UPDATE SET
        mailbox_email = excluded.mailbox_email,
        message_id = excluded.message_id,
        subject = excluded.subject,
        from_name = excluded.from_name,
        from_address = excluded.from_address,
        received_at = excluded.received_at,
        raw_r2_key = excluded.raw_r2_key,
        raw_size = excluded.raw_size,
        attachment_count = excluded.attachment_count,
        collected_at = excluded.collected_at
    `).bind(
      userId,
      mailboxKey,
      mailboxEmail,
      uidValidity,
      message.uid,
      message.messageId,
      message.subject.slice(0, 998),
      message.fromName?.slice(0, 500) ?? null,
      message.fromAddress?.slice(0, 500) ?? null,
      message.receivedAt,
      rawKey,
      message.rawBytes.byteLength,
      attachmentRows.length,
      collectedAt,
    ),
    env.DB.prepare(`
      DELETE FROM mail_attachments
      WHERE user_id = ? AND mailbox_key = ? AND uid_validity = ? AND message_uid = ?
    `).bind(userId, mailboxKey, uidValidity, message.uid),
    ...attachmentRows.map((attachment) => env.DB.prepare(`
      INSERT INTO mail_attachments (
        user_id, mailbox_key, uid_validity, message_uid, attachment_index,
        filename, content_type, size, r2_key, category, collected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      userId,
      mailboxKey,
      uidValidity,
      message.uid,
      attachment.index,
      attachment.filename,
      attachment.contentType,
      attachment.size,
      attachment.r2Key,
      attachment.category,
      collectedAt,
    )),
    ...mediaCandidates.map((candidate) => env.DB.prepare(`
      INSERT INTO mail_media_candidates (
        user_id, candidate_id, mailbox_key, mailbox_email, uid_validity,
        message_uid, attachment_index, kind, filename, subject, sender,
        received_at, attachment_r2_key, status, reason, inferred_school_name,
        assigned_school_name, attempt_count, last_attempt_at, assigned_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, NULL, ?, ?)
      ON CONFLICT(user_id, candidate_id) DO NOTHING
    `).bind(
      userId,
      candidate.id,
      mailboxKey,
      mailboxEmail,
      uidValidity,
      message.uid,
      candidate.attachmentIndex,
      candidate.kind,
      candidate.filename,
      message.subject.slice(0, 998),
      sender?.slice(0, 1000) ?? null,
      message.receivedAt,
      candidate.r2Key,
      candidate.status,
      candidate.reason,
      candidate.inferredSchoolName,
      collectedAt,
      collectedAt,
    )),
    env.DB.prepare(`
      UPDATE mail_settings
      SET uid_validity = ?, last_uid = ?, updated_at = ?
      WHERE user_id = ? AND sync_lock_token = ?
    `).bind(uidValidity, message.uid, collectedAt, userId, lockToken),
  ];
  const results = await env.DB.batch(statements);
  const checkpoint = results.at(-1);
  if (!checkpoint?.meta.changes) {
    throw new MailApiError(409, "mail_sync_lock_lost", "本次邮箱收取锁已失效，当前邮件未推进收取进度；请稍后重试。");
  }
}

function candidateReasonMessage(row: MailMediaCandidateRow): string {
  const messages: Record<string, string> = {
    school_confirmation_required: "未能可靠识别学校，请人工确认后归档。",
    multiple_known_schools_matched: "邮件同时出现多所已知学校，请人工确认。",
    multiple_school_names_matched: "邮件同时出现多个学校名称，请人工确认。",
    known_school_unique_match: "已唯一匹配历史学校记录，等待自动归档。",
    explicit_school_name_match: "已从主题或文件名识别学校，等待自动归档。",
    media_import_in_progress: "正在汇入共享媒体库。",
    imported: "已汇入共享媒体库。",
    duplicate: "共享库已有相同版本，已完成归档。",
    "older-or-equal": "共享库已保留更新版本，本附件已完成核对。",
    superseded: "归档期间收到更新版本，已保留较新文件。",
    mail_media_import_retry: "暂时无法汇入共享库，系统将自动重试。",
    invalid_jpeg_header: "JPG 文件头不正确，不能归档。",
    invalid_ai_header: "AI 文件头不正确，不能归档。",
    invalid_mp4_header: "MP4 文件头不正确，不能归档。",
    file_too_large: "附件超过媒体库大小上限，不能归档。",
  };
  return messages[row.reason] ?? (row.status === "invalid"
    ? "附件格式复验未通过，不能归档。"
    : row.status === "retry"
      ? "暂时无法汇入共享库，系统将自动重试。"
      : "请根据当前状态处理该附件。");
}

function candidateFromRow(row: MailMediaCandidateRow): Record<string, unknown> {
  return {
    id: row.candidate_id,
    mailboxEmail: row.mailbox_email,
    uidValidity: row.uid_validity,
    messageUid: row.message_uid,
    attachmentIndex: row.attachment_index,
    kind: row.kind,
    filename: row.filename,
    subject: row.subject || "（无主题）",
    sender: row.sender,
    receivedAt: row.received_at,
    status: row.status,
    reason: row.reason,
    reasonMessage: candidateReasonMessage(row),
    inferredSchoolName: row.inferred_school_name,
    assignedSchoolName: row.assigned_school_name,
    attemptCount: row.attempt_count,
    lastAttemptAt: row.last_attempt_at,
    assignedAt: row.assigned_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    source: "email",
    downloadUrl: `/api/mail-attachments/${encodeURIComponent(row.mailbox_key)}/${encodeURIComponent(row.uid_validity)}/${row.message_uid}/${row.attachment_index}/download`,
    canAssign: row.status === "pending" || row.status === "retry",
    actionRequired: row.status === "pending" || row.status === "retry" || row.status === "invalid",
  };
}

const candidateColumns = `
  candidate_id, mailbox_key, mailbox_email, uid_validity, message_uid,
  attachment_index, kind, filename, subject, sender, received_at,
  attachment_r2_key, status, reason, inferred_school_name,
  assigned_school_name, attempt_count, last_attempt_at, assigned_at,
  created_at, updated_at
`;

async function getMailMediaCandidate(
  db: D1Database,
  userId: string,
  candidateId: string,
): Promise<MailMediaCandidateRow | null> {
  return db.prepare(`
    SELECT ${candidateColumns}
    FROM mail_media_candidates
    WHERE user_id = ? AND candidate_id = ?
  `).bind(userId, candidateId).first<MailMediaCandidateRow>();
}

function normalizeAssignedSchool(value: string): string {
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > 200 || /[\r\n\0]/u.test(normalized)) {
    throw new MailApiError(400, "invalid_school_name", "学校名称格式不正确或过长。");
  }
  return normalized;
}

function boundedMailSubmittedAt(receivedAt: string | null, createdAt: string): string {
  const createdTimestamp = Date.parse(createdAt);
  if (!Number.isFinite(createdTimestamp)) {
    throw new MailApiError(500, "invalid_candidate_created_at", "邮件媒体候选的入库时间无效，请稍后重试。");
  }
  const receivedTimestamp = Date.parse(receivedAt ?? "");
  const submittedTimestamp = Number.isFinite(receivedTimestamp)
    ? Math.min(receivedTimestamp, createdTimestamp)
    : createdTimestamp;
  return new Date(submittedTimestamp).toISOString();
}

function permanentMediaImportError(error: MediaAssetApiError): boolean {
  return [
    "empty_file",
    "file_too_large",
    "poster_format_required",
    "video_format_required",
    "invalid_jpeg_header",
    "invalid_ai_header",
    "invalid_mp4_header",
    "invalid_zip_header",
    "invalid_7z_header",
    "invalid_rar_header",
    "before_collection_start",
  ].includes(error.code);
}

async function storeCandidateFailure(
  env: MailEnv,
  userId: string,
  row: MailMediaCandidateRow,
  error: unknown,
): Promise<void> {
  const now = new Date().toISOString();
  const invalidSchool = error instanceof MediaAssetApiError && error.code === "invalid_school_name";
  const permanent = error instanceof MediaAssetApiError && permanentMediaImportError(error);
  const code = error instanceof MediaAssetApiError ? error.code : "mail_media_import_retry";
  const status: MailMediaCandidateStatus = invalidSchool ? "pending" : permanent ? "invalid" : "retry";
  const message = invalidSchool
    ? "学校名称无法用于共享媒体库，请人工确认学校名称。"
    : permanent
    ? "邮件媒体附件格式复验未通过，请检查原附件。"
    : "邮件媒体暂时无法汇入共享库，系统将在后续收取任务中重试。";
  const updated = await env.DB.prepare(`
    UPDATE mail_media_candidates
    SET status = ?, reason = ?, updated_at = ?
    WHERE user_id = ? AND candidate_id = ? AND status = 'processing'
      AND attempt_count = ?
  `).bind(status, code, now, userId, row.candidate_id, row.attempt_count).run();
  if (!updated.meta.changes) return;
  await env.DB.prepare(`
      INSERT INTO mail_issues (
        user_id, issue_id, mailbox_email, message_uid, reason_code, message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, issue_id) DO UPDATE SET
        mailbox_email = excluded.mailbox_email,
        message_uid = excluded.message_uid,
        reason_code = excluded.reason_code,
        message = excluded.message,
        created_at = excluded.created_at
    `).bind(
      userId,
      `media-${row.candidate_id}`,
      row.mailbox_email,
      row.message_uid,
      permanent ? `mail_media_${code}` : invalidSchool ? "mail_media_school_confirmation" : "mail_media_import_retry",
      message,
      now,
    ).run();
}

async function processMailMediaCandidate(
  env: MailEnv,
  userId: string,
  candidateId: string,
  requestedSchoolName: string,
): Promise<{ candidate: Record<string, unknown>; accepted: boolean; reason?: string; asset?: unknown }> {
  const schoolName = normalizeAssignedSchool(requestedSchoolName);
  const now = new Date();
  const staleAt = new Date(now.getTime() - 10 * 60_000).toISOString();
  const claimed = await env.DB.prepare(`
    UPDATE mail_media_candidates
    SET status = 'processing', reason = 'media_import_in_progress',
        assigned_school_name = ?, attempt_count = attempt_count + 1,
        last_attempt_at = ?, updated_at = ?
    WHERE user_id = ? AND candidate_id = ?
      AND (
        status IN ('pending', 'retry')
        OR (
          status = 'processing'
          AND assigned_school_name = ?
          AND (last_attempt_at IS NULL OR last_attempt_at <= ?)
        )
      )
    RETURNING ${candidateColumns}
  `).bind(
    schoolName,
    now.toISOString(),
    now.toISOString(),
    userId,
    candidateId,
    schoolName,
    staleAt,
  ).first<MailMediaCandidateRow>();
  if (!claimed) {
    const existing = await getMailMediaCandidate(env.DB, userId, candidateId);
    if (!existing) throw new MailApiError(404, "mail_media_candidate_not_found", "未找到该邮件媒体候选项。");
    if (existing.status === "assigned") {
      if (normalizedSearchText(existing.assigned_school_name ?? "") !== normalizedSearchText(schoolName)) {
        throw new MailApiError(409, "mail_media_candidate_already_assigned", "该附件已归入另一所学校，未重复处理。");
      }
      return { candidate: candidateFromRow(existing), accepted: false, reason: "already-assigned" };
    }
    if (existing.status === "processing") {
      throw new MailApiError(409, "mail_media_candidate_processing", "该附件正在归档，请稍后刷新。");
    }
    if (existing.status === "invalid") {
      throw new MailApiError(422, "mail_media_candidate_invalid", "该附件格式复验未通过，不能归入共享库。");
    }
    throw new MailApiError(409, "mail_media_candidate_unavailable", "该附件当前不能归档。");
  }

  try {
    const stillOwned = await env.DB.prepare(`
      SELECT candidate_id
      FROM mail_media_candidates
      WHERE user_id = ? AND candidate_id = ? AND status = 'processing'
        AND attempt_count = ? AND assigned_school_name = ?
    `).bind(userId, claimed.candidate_id, claimed.attempt_count, schoolName).first<{ candidate_id: string }>();
    if (!stillOwned) {
      throw new MailApiError(409, "mail_media_candidate_lock_lost", "候选处理权已更新，本次未继续归档。");
    }
    // Date is supplied by the sender and is therefore untrusted. Never let a
    // future-dated message permanently outrank later real submissions.
    const submittedAt = boundedMailSubmittedAt(claimed.received_at, claimed.created_at);
    const imported = await importStoredMediaAsset(env, userId, claimed.attachment_r2_key, {
      kind: claimed.kind,
      schoolName,
      filename: claimed.filename,
      submittedAt,
      submissionId: `mail-${claimed.candidate_id}`,
      source: "email",
      sourceRef: `mail-candidate:${claimed.candidate_id}`,
    });
    const completedAt = new Date().toISOString();
    const updated = await env.DB.prepare(`
      UPDATE mail_media_candidates
      SET status = 'assigned', reason = ?, assigned_school_name = ?,
          assigned_at = ?, updated_at = ?
      WHERE user_id = ? AND candidate_id = ? AND status = 'processing'
        AND attempt_count = ?
      RETURNING ${candidateColumns}
    `).bind(
      imported.reason ?? "imported",
      schoolName,
      completedAt,
      completedAt,
      userId,
      claimed.candidate_id,
      claimed.attempt_count,
    ).first<MailMediaCandidateRow>();
    if (!updated) {
      throw new MailApiError(409, "mail_media_candidate_lock_lost", "媒体已处理，但候选状态锁已失效；请稍后重试确认。");
    }
    await env.DB.prepare("DELETE FROM mail_issues WHERE user_id = ? AND issue_id = ?")
      .bind(userId, `media-${claimed.candidate_id}`)
      .run();
    return {
      candidate: candidateFromRow(updated),
      accepted: imported.accepted,
      reason: imported.reason,
      asset: imported.asset,
    };
  } catch (error) {
    await storeCandidateFailure(env, userId, claimed, error).catch(() => undefined);
    throw error;
  }
}

async function retryMailMediaCandidates(env: MailEnv, userId: string, limit: number): Promise<void> {
  const staleAt = new Date(Date.now() - 10 * 60_000).toISOString();
  const result = await env.DB.prepare(`
    SELECT candidate_id,
           CASE WHEN status = 'processing' THEN assigned_school_name ELSE inferred_school_name END AS target_school_name
    FROM mail_media_candidates
    WHERE user_id = ?
      AND (
        (status = 'retry' AND inferred_school_name IS NOT NULL)
        OR (
          status = 'processing' AND assigned_school_name IS NOT NULL
          AND (last_attempt_at IS NULL OR last_attempt_at <= ?)
        )
      )
    ORDER BY updated_at ASC
    LIMIT ?
  `).bind(userId, staleAt, limit).all<{ candidate_id: string; target_school_name: string }>();
  for (const row of result.results) {
    try {
      await processMailMediaCandidate(env, userId, row.candidate_id, row.target_school_name);
    } catch {
      // Candidate status and a sanitized issue are persisted by the processor.
    }
  }
}

function issueCode(error: unknown): string {
  if (error instanceof AlibabaImapError) return `imap_${error.code.toLocaleLowerCase("en-US")}`;
  if (error instanceof MailApiError) return error.code;
  return "mail_sync_failed";
}

async function recordIssue(
  env: MailEnv,
  userId: string,
  email: string | null,
  error: unknown,
  messageUid: number | null = null,
): Promise<void> {
  const safe = sanitizeMailError(error);
  const issueId = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO mail_issues (user_id, issue_id, mailbox_email, message_uid, reason_code, message, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(userId, issueId, email, messageUid, issueCode(error), safe.message, new Date().toISOString()).run();
  await env.DB.prepare(`
    DELETE FROM mail_issues
    WHERE user_id = ? AND issue_id IN (
      SELECT issue_id FROM mail_issues WHERE user_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET 100
    )
  `).bind(userId, userId).run();
}

async function resetUidValidityCheckpoint(
  env: MailEnv,
  userId: string,
  lockToken: string,
  uidValidity: string,
): Promise<void> {
  const result = await env.DB.prepare(`
    UPDATE mail_settings
    SET uid_validity = ?, last_uid = 0, updated_at = ?
    WHERE user_id = ? AND sync_lock_token = ?
  `).bind(uidValidity, new Date().toISOString(), userId, lockToken).run();
  if (!result.meta.changes) {
    throw new MailApiError(409, "mail_sync_lock_lost", "本次邮箱收取锁已失效，系统未重置邮箱版本；请稍后重试。");
  }
}

async function recordPermanentMessageIssue(
  env: MailEnv,
  userId: string,
  lockToken: string,
  mailboxKey: string,
  email: string,
  failure: PermanentMailMessageFailure,
): Promise<void> {
  const now = new Date().toISOString();
  const issueId = (await sha256Hex(
    `chemecar-mail-message-issue-v1:${userId}:${mailboxKey}:${failure.uidValidity}:${failure.uid}:${issueCode(failure.error)}`,
  )).slice(0, 64);
  const message = failure.error.code === "LIMIT_EXCEEDED"
    ? "该封邮件或附件超过安全收取上限，已跳过并继续收取后续邮件。"
    : "该封邮件的 MIME 格式无法解析或使用了不支持的传输编码，已跳过并继续收取后续邮件。";
  const results = await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO mail_issues (
        user_id, issue_id, mailbox_email, message_uid, reason_code, message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, issue_id) DO UPDATE SET
        mailbox_email = excluded.mailbox_email,
        message_uid = excluded.message_uid,
        reason_code = excluded.reason_code,
        message = excluded.message,
        created_at = excluded.created_at
    `).bind(
      userId,
      issueId,
      email,
      failure.uid,
      issueCode(failure.error),
      message,
      now,
    ),
    env.DB.prepare(`
      DELETE FROM mail_issues
      WHERE user_id = ? AND issue_id IN (
        SELECT issue_id FROM mail_issues
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT -1 OFFSET 100
      )
    `).bind(userId, userId),
    env.DB.prepare(`
      UPDATE mail_settings
      SET uid_validity = ?, last_uid = ?, updated_at = ?
      WHERE user_id = ? AND sync_lock_token = ?
    `).bind(failure.uidValidity, failure.uid, now, userId, lockToken),
  ]);
  const checkpoint = results.at(-1);
  if (!checkpoint?.meta.changes) {
    throw new MailApiError(409, "mail_sync_lock_lost", "本次邮箱收取锁已失效，异常邮件未推进收取进度；请稍后重试。");
  }
}

async function acquireSyncLock(env: MailEnv, userId: string): Promise<MailSettingsRow> {
  const now = new Date();
  const lockUntil = new Date(now.getTime() + LOCK_MINUTES * 60_000).toISOString();
  const token = crypto.randomUUID();
  const row = await env.DB.prepare(`
    UPDATE mail_settings
    SET sync_lock_token = ?, sync_lock_until = ?, last_sync_status = 'running',
        last_sync_error = NULL, updated_at = ?
    WHERE user_id = ?
      AND credential_ciphertext IS NOT NULL
      AND (sync_lock_until IS NULL OR sync_lock_until <= ?)
    RETURNING user_id, email, imap_host, imap_port, credential_ciphertext, starts_at,
              run_time, timezone, interval_minutes, enabled, next_run_at,
              uid_validity, last_uid, last_synced_at, last_sync_status,
              last_sync_error, sync_lock_token, sync_lock_until, updated_at
  `).bind(token, lockUntil, now.toISOString(), userId, now.toISOString()).first<MailSettingsRow>();
  if (row) return row;
  const existing = await getSettingsRow(env.DB, userId);
  if (!existing?.credential_ciphertext) {
    throw new MailApiError(400, "mail_not_configured", "请先保存阿里邮箱账号和第三方客户端安全密码。");
  }
  throw new MailApiError(409, "mail_sync_in_progress", "邮箱正在由另一位操作者收取，请稍后刷新。");
}

async function releaseSyncLock(
  env: MailEnv,
  userId: string,
  token: string,
  values: { status: "success" | "error"; error: string | null; nextRunAt: string | null; lastSyncedAt: string | null; uidValidity?: string; lastUid?: number },
): Promise<void> {
  const result = await env.DB.prepare(`
    UPDATE mail_settings
    SET sync_lock_token = NULL, sync_lock_until = NULL, last_sync_status = ?,
        last_sync_error = ?, next_run_at = ?, last_synced_at = ?,
        uid_validity = COALESCE(?, uid_validity), last_uid = COALESCE(?, last_uid),
        updated_at = ?
    WHERE user_id = ? AND sync_lock_token = ?
  `).bind(
    values.status,
    values.error,
    values.nextRunAt,
    values.lastSyncedAt,
    values.uidValidity ?? null,
    values.lastUid ?? null,
    new Date().toISOString(),
    userId,
    token,
  ).run();
  if (!result.meta.changes) {
    throw new MailApiError(409, "mail_sync_lock_lost", "本次邮箱收取锁已失效，系统未推进收取进度；请稍后重试。");
  }
}

async function syncMailbox(env: MailEnv, userId: string): Promise<{ collected: number; hasMore: boolean }> {
  await ensureMailSchema(env.DB);
  const row = await acquireSyncLock(env, userId);
  const token = row.sync_lock_token!;
  try {
    const password = await configuredCredential(env, row);
    const mailboxKey = (await sha256Hex(`chemecar-mailbox-v1:${row.email}`)).slice(0, 32);
    const result = await fetchAlibabaMailIncremental({
      email: row.email,
      password,
      host: row.imap_host,
      port: row.imap_port,
      connectTimeoutMs: 30_000,
      commandTimeoutMs: 60_000,
      overallTimeoutMs: 120_000,
      sinceUid: row.last_uid,
      sinceDate: row.starts_at,
      expectedUidValidity: row.uid_validity,
      maxMessages: MAX_SYNC_MESSAGES,
      maxTotalBytes: MAX_SYNC_BYTES,
      maxMessageBytes: MAX_MESSAGE_BYTES,
      maxAttachmentBytes: MAX_ATTACHMENT_BYTES,
      maxTotalAttachmentBytes: MAX_SYNC_BYTES,
      onUidValidityReset: (uidValidity) => resetUidValidityCheckpoint(
        env,
        userId,
        token,
        uidValidity,
      ),
      onMessage: (message, uidValidity) => putMessage(
        env,
        userId,
        token,
        mailboxKey,
        row.email,
        uidValidity,
        message,
      ),
      onPermanentMessageError: (failure) => recordPermanentMessageIssue(
        env,
        userId,
        token,
        mailboxKey,
        row.email,
        failure,
      ),
    });
    const now = new Date();
    const schedule: MailSchedule = {
      startsAt: row.starts_at,
      runTime: row.run_time,
      timezone: row.timezone,
      intervalMinutes: row.interval_minutes,
      enabled: row.enabled === 1,
      nextRunAt: row.next_run_at,
    };
    const regularNext = calculateNextRunAt(schedule, now.getTime());
    const nextRunAt = result.hasMore && schedule.enabled
      ? new Date(now.getTime() + BACKLOG_RETRY_MINUTES * 60_000).toISOString()
      : regularNext;
    await releaseSyncLock(env, userId, token, {
      status: "success",
      error: null,
      nextRunAt,
      lastSyncedAt: now.toISOString(),
      uidValidity: result.uidValidity,
      lastUid: result.highestUid,
    });
    await retryMailMediaCandidates(env, userId, 3).catch(() => undefined);
    return { collected: result.processedCount, hasMore: result.hasMore };
  } catch (error) {
    const safe = sanitizeMailError(error);
    const retryAt = row.enabled === 1 ? new Date(Date.now() + 15 * 60_000).toISOString() : null;
    await Promise.allSettled([
      releaseSyncLock(env, userId, token, {
        status: "error",
        error: safe.message,
        nextRunAt: retryAt,
        lastSyncedAt: row.last_synced_at,
      }),
      recordIssue(env, userId, row.email || null, error),
    ]);
    throw safe;
  }
}

export async function syncMailNow(request: Request, env: MailEnv, userId: string): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  try {
    const result = await syncMailbox(env, userId);
    return mailJson({
      ok: true,
      collected: result.collected,
      received: result.collected,
      hasMore: result.hasMore,
      message: result.hasMore
        ? `本次已收取 ${result.collected} 封邮件，仍有历史邮件；请再次点击“立即收取”或启用定时计划。`
        : `收取完成，本次处理 ${result.collected} 封邮件。`,
    });
  } catch (error) {
    return responseFromError(error);
  }
}

export async function runDueMailCollectors(env: MailEnv): Promise<void> {
  await ensureMailSchema(env.DB);
  const due = await env.DB.prepare(`
    SELECT user_id
    FROM mail_settings
    WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
    ORDER BY next_run_at ASC
    LIMIT 10
  `).bind(new Date().toISOString()).all<{ user_id: string }>();
  for (const row of due.results) {
    try {
      await syncMailbox(env, row.user_id);
    } catch {
      // syncMailbox already stores a sanitized issue and next retry time.
    }
  }
  const retryUsers = await env.DB.prepare(`
    SELECT user_id
    FROM mail_media_candidates
    WHERE (
        (status = 'retry' AND inferred_school_name IS NOT NULL)
        OR (
          status = 'processing' AND assigned_school_name IS NOT NULL
          AND (last_attempt_at IS NULL OR last_attempt_at <= ?)
        )
      )
    GROUP BY user_id
    ORDER BY MIN(updated_at) ASC
    LIMIT 10
  `).bind(new Date(Date.now() - 10 * 60_000).toISOString()).all<{ user_id: string }>();
  for (const row of retryUsers.results) {
    await retryMailMediaCandidates(env, row.user_id, 3).catch(() => undefined);
  }
}

async function downloadR2Object(object: R2ObjectBody, filename: string, contentType: string): Promise<Response> {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", contentType || "application/octet-stream");
  headers.set("Content-Disposition", contentDisposition(filename));
  headers.set("Content-Length", String(object.size));
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("ETag", object.httpEtag);
  return new Response(object.body, { headers });
}

export async function downloadMailAttachment(
  request: Request,
  env: MailEnv,
  userId: string,
  encodedMailboxKey: string,
  encodedUidValidity: string,
  encodedMessageUid: string,
  encodedAttachmentIndex: string,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  try {
    await ensureMailSchema(env.DB);
    const mailboxKey = safeSegment(encodedMailboxKey, /^[a-f0-9]{32}$/u, "邮箱标识");
    const uidValidity = safeSegment(encodedUidValidity, /^[A-Za-z0-9._-]{1,80}$/u, "邮箱版本标识");
    const messageUid = Number(safeSegment(encodedMessageUid, /^\d{1,16}$/u, "邮件 UID"));
    const attachmentIndex = Number(safeSegment(encodedAttachmentIndex, /^\d{1,3}$/u, "附件序号"));
    const row = await env.DB.prepare(`
      SELECT filename, content_type, r2_key
      FROM mail_attachments
      WHERE user_id = ? AND mailbox_key = ? AND uid_validity = ?
        AND message_uid = ? AND attachment_index = ?
    `).bind(userId, mailboxKey, uidValidity, messageUid, attachmentIndex).first<{ filename: string; content_type: string; r2_key: string }>();
    if (!row) throw new MailApiError(404, "mail_attachment_not_found", "未找到该邮件附件。");
    const object = await env.FILES.get(row.r2_key);
    if (!object) throw new MailApiError(404, "stored_mail_attachment_not_found", "附件索引存在，但云端文件未找到。");
    return downloadR2Object(object, row.filename, row.content_type);
  } catch (error) {
    return responseFromError(error);
  }
}

export async function deleteMailAttachment(
  request: Request,
  env: MailEnv,
  userId: string,
  encodedMailboxKey: string,
  encodedUidValidity: string,
  encodedMessageUid: string,
  encodedAttachmentIndex: string,
): Promise<Response> {
  if (request.method !== "DELETE") return methodNotAllowed(["DELETE"]);
  try {
    await ensureMailSchema(env.DB);
    const mailboxKey = safeSegment(encodedMailboxKey, /^[a-f0-9]{32}$/u, "邮箱标识");
    const uidValidity = safeSegment(encodedUidValidity, /^[A-Za-z0-9._-]{1,80}$/u, "邮箱版本标识");
    const messageUid = Number(safeSegment(encodedMessageUid, /^\d{1,16}$/u, "邮件 UID"));
    const attachmentIndex = Number(safeSegment(encodedAttachmentIndex, /^\d{1,3}$/u, "附件序号"));
    const body = await request.json().catch(() => null) as { filename?: unknown } | null;
    const expectedFilename = typeof body?.filename === "string" ? body.filename.normalize("NFKC").trim() : "";
    if (!expectedFilename) throw new MailApiError(400, "filename_required", "缺少删除确认所需的附件文件名。" );
    const row = await env.DB.prepare(`SELECT filename, r2_key FROM mail_attachments
      WHERE user_id = ? AND mailbox_key = ? AND uid_validity = ? AND message_uid = ? AND attachment_index = ?`)
      .bind(userId, mailboxKey, uidValidity, messageUid, attachmentIndex).first<{ filename: string; r2_key: string }>();
    if (!row) throw new MailApiError(404, "mail_attachment_not_found", "未找到该邮件附件。" );
    if (row.filename !== expectedFilename) throw new MailApiError(409, "mail_attachment_changed", "附件记录已变化，请刷新后重新确认删除。" );
    const results = await env.DB.batch([
      env.DB.prepare(`DELETE FROM mail_media_candidates WHERE user_id = ? AND mailbox_key = ? AND uid_validity = ? AND message_uid = ? AND attachment_index = ?`)
        .bind(userId, mailboxKey, uidValidity, messageUid, attachmentIndex),
      env.DB.prepare(`DELETE FROM mail_attachments WHERE user_id = ? AND mailbox_key = ? AND uid_validity = ? AND message_uid = ? AND attachment_index = ? AND filename = ?`)
        .bind(userId, mailboxKey, uidValidity, messageUid, attachmentIndex, expectedFilename),
      env.DB.prepare(`UPDATE mail_messages SET attachment_count = MAX(0, attachment_count - 1)
        WHERE user_id = ? AND mailbox_key = ? AND uid_validity = ? AND message_uid = ?`)
        .bind(userId, mailboxKey, uidValidity, messageUid),
    ]);
    if (!results[1]?.meta.changes) throw new MailApiError(409, "mail_attachment_changed", "附件记录已变化，请刷新后重新确认删除。" );
    await env.FILES.delete(row.r2_key).catch((error) => console.error("Could not remove orphaned mail attachment", error));
    return mailJson({ ok: true, deleted: true });
  } catch (error) {
    return responseFromError(error);
  }
}

export async function downloadRawMail(
  request: Request,
  env: MailEnv,
  userId: string,
  encodedMailboxKey: string,
  encodedUidValidity: string,
  encodedMessageUid: string,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  try {
    await ensureMailSchema(env.DB);
    const mailboxKey = safeSegment(encodedMailboxKey, /^[a-f0-9]{32}$/u, "邮箱标识");
    const uidValidity = safeSegment(encodedUidValidity, /^[A-Za-z0-9._-]{1,80}$/u, "邮箱版本标识");
    const messageUid = Number(safeSegment(encodedMessageUid, /^\d{1,16}$/u, "邮件 UID"));
    const row = await env.DB.prepare(`
      SELECT raw_r2_key
      FROM mail_messages
      WHERE user_id = ? AND mailbox_key = ? AND uid_validity = ? AND message_uid = ?
    `).bind(userId, mailboxKey, uidValidity, messageUid).first<{ raw_r2_key: string }>();
    if (!row) throw new MailApiError(404, "mail_message_not_found", "未找到该邮件。");
    const object = await env.FILES.get(row.raw_r2_key);
    if (!object) throw new MailApiError(404, "stored_mail_message_not_found", "邮件索引存在，但云端原文未找到。");
    return downloadR2Object(object, `mail-${messageUid}.eml`, "message/rfc822");
  } catch (error) {
    return responseFromError(error);
  }
}
