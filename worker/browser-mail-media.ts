import { inferSchoolNameFromFilename, normalizeCompetitionSchoolName } from "./file-metadata";

export type BrowserMailMediaKind = "poster" | "video";

export interface BrowserMailAttachmentInput {
  filename: string;
  subject: string;
  contentType: string;
  surroundingText?: string;
}

export interface BrowserMailClassification {
  kind: BrowserMailMediaKind | null;
  reason: string;
}

export interface BrowserMailMediaEnv {
  DB: D1Database;
  FILES: R2Bucket;
}

export type BrowserMailBatchAction = "upload" | "skip" | "candidate" | "reject";

export interface BrowserMailBatchResult {
  fingerprint: string;
  action: BrowserMailBatchAction;
  kind: BrowserMailMediaKind | null;
  reason: string;
  schoolName?: string;
  schoolKey?: string;
  filename?: string;
  size?: number;
  submittedAt?: string;
  submissionId?: string;
  sourceRef?: string;
}

const ARCHIVE_EXTENSIONS = new Set(["zip", "7z", "rar"]);
const POSTER_HINT = /(?:海报|展板|poster)/iu;
const VIDEO_HINT = /(?:宣传视频|宣传片|视频|video|mp4)/iu;
const MAX_MEDIA_BYTES = 200 * 1024 * 1024;
const MAX_MESSAGES_PER_BATCH = 50;
const MAX_ATTACHMENTS_PER_BATCH = 100;
const schemaPromises = new WeakMap<object, Promise<void>>();

class BrowserMailApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "BrowserMailApiError";
  }
}

function browserMailJson(value: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  responseHeaders.set("Cache-Control", "no-store");
  responseHeaders.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(value), { status, headers: responseHeaders });
}

function browserMailError(error: BrowserMailApiError): Response {
  return browserMailJson({ ok: false, error: { code: error.code, message: error.message } }, error.status);
}

function methodNotAllowed(methods: string[]): Response {
  return browserMailJson({ ok: false, error: { code: "method_not_allowed", message: `此接口仅支持 ${methods.join("、")} 请求。` } }, 405, { Allow: methods.join(", ") });
}

function requireKind(value: unknown): BrowserMailMediaKind {
  if (value !== "poster" && value !== "video") {
    throw new BrowserMailApiError(400, "invalid_media_kind", "媒体类别必须是 poster 或 video。");
  }
  return value;
}

function normalizedText(value: unknown, maximum: number, required = false): string {
  const normalized = typeof value === "string" ? value.normalize("NFKC").trim() : "";
  if ((required && !normalized) || normalized.length > maximum || /[\r\n\0]/u.test(normalized)) {
    throw new BrowserMailApiError(400, "invalid_scan_data", "阿里邮箱扫描数据缺少必要字段或字段过长。");
  }
  return normalized;
}

function normalizedTimestamp(value: unknown): string {
  const source = normalizedText(value, 100, true);
  const timestamp = Date.parse(source);
  if (!Number.isFinite(timestamp)) throw new BrowserMailApiError(400, "invalid_received_at", "邮件收件时间不是有效日期。");
  return new Date(timestamp).toISOString();
}

function normalizedFingerprint(value: unknown): string {
  const fingerprint = normalizedText(value, 200, true);
  if (!/^[A-Za-z0-9._:-]+$/u.test(fingerprint)) {
    throw new BrowserMailApiError(400, "invalid_fingerprint", "邮件附件指纹格式不正确。");
  }
  return fingerprint;
}

function canonicalSchoolKey(schoolName: string): string {
  const key = schoolName.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[\s\p{P}\p{S}]+/gu, "");
  if (!key || key.length > 160 || !/^[\p{L}\p{N}\p{M}]+$/u.test(key)) {
    throw new BrowserMailApiError(400, "invalid_school_name", "学校名称无法生成有效标识。");
  }
  return key;
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("Content-Type")?.toLocaleLowerCase("en-US").includes("application/json")) {
    throw new BrowserMailApiError(415, "unsupported_media_type", "浏览器扫描接口必须使用 JSON 格式。");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 512 * 1024) {
    throw new BrowserMailApiError(413, "request_too_large", "单次浏览器扫描数据过大，请缩小批次。");
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    return parsed as Record<string, unknown>;
  } catch {
    throw new BrowserMailApiError(400, "invalid_json", "浏览器扫描数据不是有效的 JSON 对象。");
  }
}

async function ensureBrowserMailSchema(db: D1Database): Promise<void> {
  const cacheKey = db as unknown as object;
  const existing = schemaPromises.get(cacheKey);
  if (existing) return existing;
  const pending = db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS shared_media_assets (
      user_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('poster','video')),
      school_key TEXT NOT NULL, school_name TEXT NOT NULL, r2_key TEXT NOT NULL,
      filename TEXT NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL,
      submitted_at TEXT NOT NULL, submission_id TEXT NOT NULL, uploaded_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web','email')), source_ref TEXT,
      PRIMARY KEY (user_id, kind, school_key)
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_shared_media_assets_user_kind_school_name
      ON shared_media_assets (user_id, kind, school_name COLLATE NOCASE)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS media_collector_settings (
      user_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('poster','video')),
      starts_at TEXT, run_time TEXT NOT NULL DEFAULT '09:00',
      timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai', interval_minutes INTEGER NOT NULL DEFAULT 1440,
      enabled INTEGER NOT NULL DEFAULT 0, next_run_at TEXT, updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, kind)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS browser_mail_scan_checkpoints (
      user_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('poster','video')),
      mailbox_key TEXT NOT NULL DEFAULT '', last_message_key TEXT, last_scan_at TEXT,
      last_error TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (user_id, kind)
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_browser_mail_scan_checkpoints_updated
      ON browser_mail_scan_checkpoints (user_id, updated_at)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS browser_mail_seen_attachments (
      user_id TEXT NOT NULL, fingerprint TEXT NOT NULL, kind TEXT,
      school_name TEXT, filename TEXT NOT NULL, size INTEGER NOT NULL,
      received_at TEXT NOT NULL, source_ref TEXT NOT NULL, asset_school_key TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending','uploaded','candidate','missing','invalid')),
      updated_at TEXT NOT NULL, PRIMARY KEY (user_id, fingerprint)
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_browser_mail_seen_status_received
      ON browser_mail_seen_attachments (user_id, status, received_at)`),
  ]).then(() => undefined);
  schemaPromises.set(cacheKey, pending);
  try {
    await pending;
  } catch (error) {
    schemaPromises.delete(cacheKey);
    throw error;
  }
}

function filenameExtension(filename: string): string {
  const normalized = filename.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  const match = normalized.match(/\.([a-z0-9]+)$/u);
  return match?.[1] || "";
}

export function classifyBrowserMailAttachment(input: BrowserMailAttachmentInput): BrowserMailClassification {
  const filename = typeof input.filename === "string" ? input.filename : "";
  const subject = typeof input.subject === "string" ? input.subject : "";
  const surroundingText = typeof input.surroundingText === "string" ? input.surroundingText : "";
  const extension = filenameExtension(filename);

  if (["ai", "jpg", "jpeg"].includes(extension)) {
    return { kind: "poster", reason: `文件扩展名 .${extension} 明确属于海报。` };
  }
  if (extension === "mp4") {
    return { kind: "video", reason: "文件扩展名 .mp4 明确属于视频。" };
  }
  if (!ARCHIVE_EXTENSIONS.has(extension)) {
    return { kind: null, reason: "附件格式不属于海报或视频允许格式。" };
  }

  const evidence = `${filename} ${subject} ${surroundingText}`.normalize("NFKC");
  const poster = POSTER_HINT.test(evidence);
  const video = VIDEO_HINT.test(evidence);
  if (poster && !video) return { kind: "poster", reason: "压缩包名称或邮件文字明确包含海报提示。" };
  if (video && !poster) return { kind: "video", reason: "压缩包名称或邮件文字明确包含视频提示。" };
  if (poster && video) return { kind: null, reason: "压缩包同时出现海报和视频提示，需要人工归类。" };
  return { kind: null, reason: "压缩包没有明确的海报或视频提示，需要人工归类。" };
}

interface MediaSettingRow {
  starts_at: string | null;
  timezone: string;
}

interface SeenAttachmentRow {
  fingerprint: string;
  kind: BrowserMailMediaKind | null;
  school_name: string | null;
  filename: string;
  size: number;
  received_at: string;
  source_ref: string;
  asset_school_key: string | null;
  status: "pending" | "uploaded" | "candidate" | "missing" | "invalid";
}

interface SharedAssetRow {
  r2_key: string;
  submitted_at: string;
  submission_id: string;
}

function calendarDateInTimezone(timestamp: string, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(timestamp));
    const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    throw new BrowserMailApiError(500, "invalid_media_schedule", "媒体栏目保存的时区无效，请重新保存起始日期。");
  }
}

async function mediaSetting(db: D1Database, userId: string, kind: BrowserMailMediaKind): Promise<MediaSettingRow | null> {
  return db.prepare(`SELECT starts_at, timezone FROM media_collector_settings
    WHERE user_id = ? AND kind = ?`).bind(userId, kind).first<MediaSettingRow>();
}

async function upsertSeenAttachment(
  db: D1Database,
  userId: string,
  input: {
    fingerprint: string;
    kind: BrowserMailMediaKind | null;
    schoolName: string | null;
    filename: string;
    size: number;
    receivedAt: string;
    sourceRef: string;
    schoolKey: string | null;
    status: SeenAttachmentRow["status"];
  },
): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO browser_mail_seen_attachments (
    user_id, fingerprint, kind, school_name, filename, size, received_at,
    source_ref, asset_school_key, status, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, fingerprint) DO UPDATE SET
    kind = excluded.kind, school_name = excluded.school_name, filename = excluded.filename,
    size = excluded.size, received_at = excluded.received_at, source_ref = excluded.source_ref,
    asset_school_key = excluded.asset_school_key, status = excluded.status, updated_at = excluded.updated_at`)
    .bind(
      userId, input.fingerprint, input.kind, input.schoolName, input.filename, input.size,
      input.receivedAt, input.sourceRef, input.schoolKey, input.status, now,
    ).run();
}

export async function sharedMediaObjectExists(
  env: BrowserMailMediaEnv,
  userId: string,
  kind: BrowserMailMediaKind,
  fingerprint: string,
): Promise<boolean> {
  await ensureBrowserMailSchema(env.DB);
  const seen = await env.DB.prepare(`SELECT fingerprint, kind, school_name, filename, size,
    received_at, source_ref, asset_school_key, status
    FROM browser_mail_seen_attachments WHERE user_id = ? AND fingerprint = ?`)
    .bind(userId, fingerprint).first<SeenAttachmentRow>();
  if (!seen?.asset_school_key || seen.kind !== kind) return false;
  const asset = await env.DB.prepare(`SELECT r2_key, submitted_at, submission_id FROM shared_media_assets
    WHERE user_id = ? AND kind = ? AND school_key = ?`)
    .bind(userId, kind, seen.asset_school_key).first<SharedAssetRow>();
  if (!asset || asset.submission_id !== `alimail-browser:${fingerprint}`) return false;
  return Boolean(await env.FILES.head(asset.r2_key));
}

function archiveExtension(filename: string): boolean {
  return /\.(?:zip|7z|rar)$/iu.test(filename.trim());
}

function resultForInvalid(
  fingerprint: string,
  kind: BrowserMailMediaKind | null,
  action: "skip" | "candidate" | "reject",
  reason: string,
): BrowserMailBatchResult {
  return { fingerprint, action, kind, reason };
}

async function classifyBatchAttachment(
  env: BrowserMailMediaEnv,
  userId: string,
  requestedKind: BrowserMailMediaKind,
  message: Record<string, unknown>,
  attachment: Record<string, unknown>,
): Promise<BrowserMailBatchResult> {
  let fingerprint = "invalid";
  try {
    fingerprint = normalizedFingerprint(attachment.fingerprint);
    const filename = normalizedText(attachment.filename, 240, true);
    const contentType = normalizedText(attachment.contentType, 200);
    const subject = normalizedText(message.subject, 500);
    const surroundingText = normalizedText(message.surroundingText, 2_000);
    const sourceRef = normalizedText(attachment.sourceRef, 500, true);
    const receivedAt = normalizedTimestamp(message.receivedAt);
    const size = attachment.size;
    if (!Number.isSafeInteger(size) || (size as number) < 1 || (size as number) > MAX_MEDIA_BYTES) {
      await upsertSeenAttachment(env.DB, userId, {
        fingerprint, kind: null, schoolName: null, filename, size: Number.isSafeInteger(size) ? size as number : 0,
        receivedAt, sourceRef, schoolKey: null, status: "invalid",
      });
      return resultForInvalid(fingerprint, null, "reject", `文件大小必须在 1 字节至 ${MAX_MEDIA_BYTES / 1024 / 1024}MB 之间。`);
    }

    const classification = classifyBrowserMailAttachment({ filename, subject, contentType, surroundingText });
    if (!classification.kind) {
      const status = archiveExtension(filename) ? "candidate" : "invalid";
      await upsertSeenAttachment(env.DB, userId, {
        fingerprint, kind: null, schoolName: null, filename, size: size as number,
        receivedAt, sourceRef, schoolKey: null, status,
      });
      return resultForInvalid(fingerprint, null, status === "candidate" ? "candidate" : "reject", classification.reason);
    }
    if (classification.kind !== requestedKind) {
      await upsertSeenAttachment(env.DB, userId, {
        fingerprint, kind: classification.kind, schoolName: null, filename, size: size as number,
        receivedAt, sourceRef, schoolKey: null, status: "invalid",
      });
      return resultForInvalid(fingerprint, classification.kind, "skip", `当前只扫描${requestedKind === "poster" ? "海报" : "视频"}，此附件属于其他栏目。`);
    }

    const setting = await mediaSetting(env.DB, userId, classification.kind);
    if (!setting?.starts_at) {
      await upsertSeenAttachment(env.DB, userId, {
        fingerprint, kind: classification.kind, schoolName: null, filename, size: size as number,
        receivedAt, sourceRef, schoolKey: null, status: "invalid",
      });
      return resultForInvalid(fingerprint, classification.kind, "reject", "请先保存当前媒体栏目的收集起始日期。");
    }
    if (calendarDateInTimezone(receivedAt, setting.timezone || "Asia/Shanghai") < setting.starts_at) {
      await upsertSeenAttachment(env.DB, userId, {
        fingerprint, kind: classification.kind, schoolName: null, filename, size: size as number,
        receivedAt, sourceRef, schoolKey: null, status: "invalid",
      });
      return resultForInvalid(fingerprint, classification.kind, "skip", "邮件早于当前栏目设置的收集起始日期。");
    }

    const suppliedSchool = typeof attachment.schoolName === "string"
      ? normalizeCompetitionSchoolName(attachment.schoolName)
      : "";
    const schoolName = suppliedSchool || inferSchoolNameFromFilename(filename) || "";
    if (!schoolName) {
      await upsertSeenAttachment(env.DB, userId, {
        fingerprint, kind: classification.kind, schoolName: null, filename, size: size as number,
        receivedAt, sourceRef, schoolKey: null, status: "candidate",
      });
      return resultForInvalid(fingerprint, classification.kind, "candidate", "附件类型明确，但无法可靠识别学校，需要人工归类。");
    }
    const schoolKey = canonicalSchoolKey(schoolName);

    const seen = await env.DB.prepare(`SELECT fingerprint, kind, school_name, filename, size,
      received_at, source_ref, asset_school_key, status FROM browser_mail_seen_attachments
      WHERE user_id = ? AND fingerprint = ?`).bind(userId, fingerprint).first<SeenAttachmentRow>();
    if (seen?.status === "uploaded" && await sharedMediaObjectExists(env, userId, classification.kind, fingerprint)) {
      return { fingerprint, action: "skip", kind: classification.kind, reason: "相同附件及其共享云端文件仍然存在，已跳过。" };
    }

    await upsertSeenAttachment(env.DB, userId, {
      fingerprint, kind: classification.kind, schoolName, filename, size: size as number,
      receivedAt, sourceRef, schoolKey, status: seen?.status === "uploaded" ? "missing" : "pending",
    });
    return {
      fingerprint,
      action: "upload",
      kind: classification.kind,
      reason: seen?.status === "uploaded" ? "此前收集的共享文件已删除，需要重新下载。" : "附件符合当前栏目规则，需要上传到共享云端。",
      schoolName,
      schoolKey,
      filename,
      size: size as number,
      submittedAt: receivedAt,
      submissionId: `alimail-browser:${fingerprint}`,
      sourceRef,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "附件元数据无法识别。";
    return resultForInvalid(fingerprint, null, "reject", reason);
  }
}

export async function startBrowserMailScan(request: Request, env: BrowserMailMediaEnv, userId: string): Promise<Response> {
  try {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    await ensureBrowserMailSchema(env.DB);
    const body = await readJsonObject(request);
    const kind = requireKind(body.kind);
    const scanId = normalizedText(body.scanId, 100, true);
    const mailboxKey = normalizedText(body.mailboxKey, 200, true);
    const setting = await mediaSetting(env.DB, userId, kind);
    if (!setting?.starts_at) throw new BrowserMailApiError(400, "start_date_required", "请先在当前栏目保存收集起始日期。");
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO browser_mail_scan_checkpoints (
      user_id, kind, mailbox_key, last_message_key, last_scan_at, last_error, updated_at
    ) VALUES (?, ?, ?, NULL, NULL, NULL, ?)
    ON CONFLICT(user_id, kind) DO UPDATE SET mailbox_key = excluded.mailbox_key,
      last_error = NULL, updated_at = excluded.updated_at`)
      .bind(userId, kind, mailboxKey, now).run();
    return browserMailJson({ ok: true, scanId, kind, mailboxKey, startsAt: setting.starts_at, timezone: setting.timezone || "Asia/Shanghai" });
  } catch (error) {
    if (error instanceof BrowserMailApiError) return browserMailError(error);
    throw error;
  }
}

export async function ingestBrowserMailBatch(request: Request, env: BrowserMailMediaEnv, userId: string): Promise<Response> {
  try {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    await ensureBrowserMailSchema(env.DB);
    const body = await readJsonObject(request);
    const scanId = normalizedText(body.scanId, 100, true);
    const kind = requireKind(body.kind);
    normalizedText(body.mailboxKey, 200, true);
    if (!Array.isArray(body.messages) || body.messages.length > MAX_MESSAGES_PER_BATCH) {
      throw new BrowserMailApiError(400, "invalid_scan_batch", `单批最多读取 ${MAX_MESSAGES_PER_BATCH} 封邮件。`);
    }
    let attachmentCount = 0;
    const results: BrowserMailBatchResult[] = [];
    for (const rawMessage of body.messages) {
      if (!rawMessage || typeof rawMessage !== "object" || Array.isArray(rawMessage)) {
        throw new BrowserMailApiError(400, "invalid_scan_batch", "邮件扫描记录格式不正确。");
      }
      const message = rawMessage as Record<string, unknown>;
      normalizedText(message.messageKey, 200, true);
      if (!Array.isArray(message.attachments)) throw new BrowserMailApiError(400, "invalid_scan_batch", "邮件附件清单格式不正确。");
      attachmentCount += message.attachments.length;
      if (attachmentCount > MAX_ATTACHMENTS_PER_BATCH) {
        throw new BrowserMailApiError(400, "invalid_scan_batch", `单批最多读取 ${MAX_ATTACHMENTS_PER_BATCH} 个附件。`);
      }
      for (const rawAttachment of message.attachments) {
        if (!rawAttachment || typeof rawAttachment !== "object" || Array.isArray(rawAttachment)) {
          throw new BrowserMailApiError(400, "invalid_scan_batch", "附件扫描记录格式不正确。");
        }
        results.push(await classifyBatchAttachment(env, userId, kind, message, rawAttachment as Record<string, unknown>));
      }
    }
    return browserMailJson({ ok: true, scanId, kind, messages: body.messages.length, attachments: attachmentCount, results });
  } catch (error) {
    if (error instanceof BrowserMailApiError) return browserMailError(error);
    throw error;
  }
}

export async function finishBrowserMailScan(request: Request, env: BrowserMailMediaEnv, userId: string): Promise<Response> {
  try {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    await ensureBrowserMailSchema(env.DB);
    const body = await readJsonObject(request);
    const scanId = normalizedText(body.scanId, 100, true);
    const kind = requireKind(body.kind);
    const mailboxKey = normalizedText(body.mailboxKey, 200, true);
    const lastMessageKey = normalizedText(body.lastMessageKey, 200);
    const errorMessage = normalizedText(body.error, 500);
    const uploadedFingerprints = Array.isArray(body.uploadedFingerprints) ? body.uploadedFingerprints : [];
    if (uploadedFingerprints.length > MAX_ATTACHMENTS_PER_BATCH) {
      throw new BrowserMailApiError(400, "invalid_finish_batch", "本次完成记录中的附件数量过多。");
    }
    let uploaded = 0;
    for (const rawFingerprint of uploadedFingerprints) {
      const fingerprint = normalizedFingerprint(rawFingerprint);
      const seen = await env.DB.prepare(`SELECT fingerprint, kind, school_name, filename, size,
        received_at, source_ref, asset_school_key, status FROM browser_mail_seen_attachments
        WHERE user_id = ? AND fingerprint = ?`).bind(userId, fingerprint).first<SeenAttachmentRow>();
      if (!seen?.asset_school_key || seen.kind !== kind) continue;
      await env.DB.prepare(`UPDATE shared_media_assets SET source = 'email', source_ref = ?
        WHERE user_id = ? AND kind = ? AND school_key = ? AND submission_id = ?`)
        .bind(`alimail-browser:${fingerprint}`, userId, kind, seen.asset_school_key, `alimail-browser:${fingerprint}`).run();
      const exists = await sharedMediaObjectExists(env, userId, kind, fingerprint);
      await env.DB.prepare(`UPDATE browser_mail_seen_attachments SET status = ?, updated_at = ?
        WHERE user_id = ? AND fingerprint = ?`)
        .bind(exists ? "uploaded" : "missing", new Date().toISOString(), userId, fingerprint).run();
      if (exists) uploaded += 1;
    }
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO browser_mail_scan_checkpoints (
      user_id, kind, mailbox_key, last_message_key, last_scan_at, last_error, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, kind) DO UPDATE SET mailbox_key = excluded.mailbox_key,
      last_message_key = excluded.last_message_key, last_scan_at = excluded.last_scan_at,
      last_error = excluded.last_error, updated_at = excluded.updated_at`)
      .bind(userId, kind, mailboxKey, lastMessageKey || null, now, errorMessage || null, now).run();
    return browserMailJson({ ok: true, scanId, kind, uploaded, lastMessageKey: lastMessageKey || null, error: errorMessage || null });
  } catch (error) {
    if (error instanceof BrowserMailApiError) return browserMailError(error);
    throw error;
  }
}

export async function browserMailAssetsExist(request: Request, env: BrowserMailMediaEnv, userId: string): Promise<Response> {
  try {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    await ensureBrowserMailSchema(env.DB);
    const body = await readJsonObject(request);
    const kind = requireKind(body.kind);
    if (!Array.isArray(body.fingerprints) || body.fingerprints.length > MAX_ATTACHMENTS_PER_BATCH) {
      throw new BrowserMailApiError(400, "invalid_fingerprints", `一次最多核对 ${MAX_ATTACHMENTS_PER_BATCH} 个附件。`);
    }
    const results = [];
    for (const value of body.fingerprints) {
      const fingerprint = normalizedFingerprint(value);
      results.push({ fingerprint, exists: await sharedMediaObjectExists(env, userId, kind, fingerprint) });
    }
    return browserMailJson({ ok: true, kind, results });
  } catch (error) {
    if (error instanceof BrowserMailApiError) return browserMailError(error);
    throw error;
  }
}

export async function getBrowserMailScanState(request: Request, env: BrowserMailMediaEnv, userId: string): Promise<Response> {
  try {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    await ensureBrowserMailSchema(env.DB);
    const [checkpointRows, countRows] = await Promise.all([
      env.DB.prepare(`SELECT checkpoint.kind, checkpoint.mailbox_key, checkpoint.last_message_key,
        checkpoint.last_scan_at, checkpoint.last_error, checkpoint.updated_at,
        setting.starts_at, setting.timezone
        FROM browser_mail_scan_checkpoints AS checkpoint
        LEFT JOIN media_collector_settings AS setting
          ON setting.user_id = checkpoint.user_id AND setting.kind = checkpoint.kind
        WHERE checkpoint.user_id = ? ORDER BY checkpoint.kind`).bind(userId).all<Record<string, unknown>>(),
      env.DB.prepare(`SELECT kind, status, COUNT(*) AS total FROM browser_mail_seen_attachments
        WHERE user_id = ? GROUP BY kind, status`).bind(userId).all<{ kind: BrowserMailMediaKind | null; status: string; total: number }>(),
    ]);
    const counts: Record<string, number> = {};
    for (const row of countRows.results) counts[`${row.kind ?? "unknown"}:${row.status}`] = Number(row.total);
    const checkpoints = checkpointRows.results.map((row) => ({
      kind: row.kind,
      mailboxKey: row.mailbox_key,
      lastMessageKey: row.last_message_key,
      lastScanAt: row.last_scan_at,
      lastError: row.last_error,
      startsAt: row.starts_at,
      timezone: row.timezone || "Asia/Shanghai",
      updatedAt: row.updated_at,
    }));
    return browserMailJson({ ok: true, checkpoints, counts });
  } catch (error) {
    if (error instanceof BrowserMailApiError) return browserMailError(error);
    throw error;
  }
}
