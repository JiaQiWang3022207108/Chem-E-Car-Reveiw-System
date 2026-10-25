import {
  inferSchoolNameFromFilename,
  normalizeCompetitionSchoolName,
  preferDetailedCompetitionSchoolName,
} from "./file-metadata";

export type FankeCollectibleKind = "registration" | "edp";
export type FankeFileKind = FankeCollectibleKind | "poster" | "video";

export function parseFankeCollectibleKind(value: unknown): FankeCollectibleKind | null {
  return value === "registration" || value === "edp" ? value : null;
}

export interface FankeCollectorEnv {
  DB: D1Database;
}

interface FankeCollectionWindow {
  startsAt: string;
  timezone: string;
}

export interface FankeQueueFile {
  queueId: string;
  formId: string | null;
  submissionId: string;
  submittedAt: string;
  schoolName: string;
  fileId: string | null;
  filename: string;
  downloadUrl: string;
  size: number | null;
  kind: FankeFileKind;
  attemptCount: number;
}

export interface FankeProcessResult {
  status: "processed" | "ignored" | "invalid";
  message?: string;
}

export type FankeFileProcessor = (file: FankeQueueFile) => Promise<FankeProcessResult>;

interface ConnectorRow {
  form_id: string | null;
  enabled: number;
  secret_prefix: string;
  last_event_at: string | null;
  last_processed_at: string | null;
  last_error: string | null;
  updated_at: string;
}

interface QueueRow {
  queue_id: string;
  form_id: string | null;
  submission_id: string;
  submitted_at: string;
  school_name: string;
  file_id: string | null;
  filename: string;
  download_url: string;
  size: number | null;
  kind: FankeFileKind;
  status: string;
  attempt_count: number;
  last_error: string | null;
  received_at: string;
  processed_at: string | null;
}

interface ParsedFile {
  formId: string | null;
  submissionId: string;
  submittedAt: string;
  schoolName: string;
  fileId: string | null;
  filename: string;
  downloadUrl: string;
  size: number | null;
  kind: FankeFileKind;
}

interface AssistantSubmissionRow {
  revision_hash: string;
  revision_number: number;
  submitted_at: string;
  school_name: string;
}

interface AssistantFileRow {
  file_key: string;
  fingerprint: string;
}

interface StoredLibraryVersionRow {
  school_name: string;
  submitted_at: string;
}

interface QueuedSchoolVersionRow extends StoredLibraryVersionRow {
  submission_id: string;
}

interface QueuedSchoolVersion {
  submittedAt: string;
  submissionId: string;
}

interface AssistantInputFile {
  fileId: string | null;
  filename: string;
  downloadUrl: string;
  size: number | null;
  context: string;
  kind: FankeFileKind | null;
  fileKey: string;
  fingerprint: string;
}

interface AssistantInputRecord {
  submissionId: string;
  submittedAt: string;
  updatedAt: string | null;
  schoolName: string;
  revisionHash: string;
  files: AssistantInputFile[];
}

interface FileCandidate {
  filename: string;
  url: URL;
  fileId: string | null;
  size: number | null;
  context: string;
}

const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024;
const MAX_ASSISTANT_RECORDS = 50;
const MAX_QUEUE_BATCH = 20;
const MAX_ATTEMPTS = 8;
const STALE_PROCESSING_MS = 15 * 60 * 1000;
const schemaPromises = new WeakMap<object, Promise<void>>();
const decoder = new TextDecoder();

function responseJson(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(data), { status, headers });
}

function methodNotAllowed(allowed: string[]): Response {
  return responseJson({ ok: false, error: { code: "method_not_allowed", message: `此接口仅支持 ${allowed.join("、")} 请求。` } }, 405, { Allow: allowed.join(", ") });
}

function normalizeText(value: unknown, maximum = 500): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!normalized || normalized.length > maximum || /[\0\r\n]/u.test(normalized)) return null;
  return normalized;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function trustedDownloadUrl(value: string): URL | null {
  try {
    const decoded = value.replace(/&amp;/gu, "&");
    const url = new URL(decoded);
    const host = url.hostname.toLocaleLowerCase("en-US");
    if (url.protocol !== "https:") return null;
    if (!/^download\.s\d+i\.co99\.net$/u.test(host)
      && !/(?:^|\.)faiusr\.com$/u.test(host)
      && !/(?:^|\.)fkw\.com$/u.test(host)) return null;
    if (url.username || url.password || url.href.length > 4096) return null;
    return url;
  } catch {
    return null;
  }
}

function filenameFromUrl(url: URL): string | null {
  const queryName = url.searchParams.get("f") ?? url.searchParams.get("filename") ?? url.searchParams.get("name");
  if (queryName) {
    try {
      return normalizeText(decodeURIComponent(queryName), 240);
    } catch {
      return normalizeText(queryName, 240);
    }
  }
  const basename = url.pathname.split("/").at(-1);
  if (!basename) return null;
  try {
    return normalizeText(decodeURIComponent(basename), 240);
  } catch {
    return normalizeText(basename, 240);
  }
}

export function classifyFankeFile(filename: string): FankeFileKind | null {
  const normalized = filename.normalize("NFKC");
  const lower = normalized.toLocaleLowerCase("en-US");
  const extension = lower.match(/\.([a-z0-9]+)$/u)?.[1] ?? "";
  if (extension === "xlsx") return "registration";
  if (["ai", "jpg", "jpeg"].includes(extension)) return "poster";
  if (extension === "mp4") return "video";
  if (["zip", "7z", "rar"].includes(extension)) {
    if (/(?:^|[^a-z])edp(?:[^a-z]|$)|工程设计|设计包/iu.test(normalized)) return "edp";
    if (/海报|poster/iu.test(normalized)) return "poster";
    if (/视频|宣传片|宣传视频|video|mp4/iu.test(normalized)) return "video";
    if (extension === "zip" && /报名|registration|参赛信息/iu.test(normalized)) return "registration";
    // An archive extension alone cannot distinguish EDP from a compressed
    // poster or video. Keep ambiguous archives unclassified until the
    // operator starts a category-specific scan; EDP archives are then verified by
    // the existing archive-content validator before they are stored.
    return null;
  }
  return null;
}

export function classifyFankeCandidate(filename: string, context: string): FankeFileKind | null {
  const normalizedFilename = filename.normalize("NFKC");
  const normalizedContext = context.normalize("NFKC");
  const lower = normalizedFilename.toLocaleLowerCase("en-US");
  const extension = lower.match(/\.([a-z0-9]+)$/u)?.[1] ?? "";
  const isArchive = ["zip", "7z", "rar"].includes(extension);

  // A compressed poster or video often has only the school name in its file
  // name. Fanke's question/field label is therefore more reliable than the
  // filename when it is available in the webhook payload.
  const posterHint = /海报|poster/iu.test(`${normalizedFilename} ${normalizedContext}`);
  if ((extension === "ai" || ["jpg", "jpeg"].includes(extension) || isArchive) && posterHint) return "poster";
  if ((extension === "mp4" || isArchive)
    && /视频|宣传片|宣传视频|video|mp4/iu.test(normalizedContext)) return "video";
  if (isArchive && /(?:^|[^a-z])edp(?:[^a-z]|$)|工程设计|设计包/iu.test(normalizedContext)) return "edp";
  if (extension === "xlsx" && /报名|registration|参赛信息/iu.test(normalizedContext)) return "registration";
  // A JPG in a form row may be an avatar, logo, QR code or thumbnail. Images
  // are only posters when the file name or the exact field label says so.
  if (extension === "ai" || ["jpg", "jpeg"].includes(extension)) return null;
  return classifyFankeFile(normalizedFilename);
}

function normalizedAssistantSchoolName(value: unknown): string | null {
  const normalized = normalizeText(value, 200);
  if (!normalized) return null;
  const schoolName = normalizeCompetitionSchoolName(normalized);
  return normalizeText(schoolName, 200);
}

function isFankePreviewImage(filename: string, url: URL): boolean {
  if (/!\d{2,4}x\d{2,4}\.(?:jpe?g|png|gif|webp)$/iu.test(url.pathname)) return true;
  if (/!\d{2,4}x\d{2,4}\.(?:jpe?g|png|gif|webp)$/iu.test(filename)) return true;
  const width = Number(url.searchParams.get("w") ?? url.searchParams.get("width"));
  const height = Number(url.searchParams.get("h") ?? url.searchParams.get("height"));
  return /\.(?:jpe?g|png|gif|webp)$/iu.test(url.pathname)
    && ((Number.isFinite(width) && width > 0 && width <= 320)
      || (Number.isFinite(height) && height > 0 && height <= 320));
}

function assistantUrlIdentity(url: URL): string {
  const fileId = url.searchParams.get("fileID") ?? url.searchParams.get("fileId");
  if (fileId) return `${url.origin}${url.pathname}?fileID=${fileId}`;
  const originalName = url.searchParams.get("f") ?? url.searchParams.get("filename") ?? url.searchParams.get("name");
  return `${url.origin}${url.pathname}${originalName ? `?f=${originalName}` : ""}`;
}

function parseDateValue(value: unknown, fallback: string): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value > 10_000_000_000 ? value : value * 1000;
    const parsed = new Date(milliseconds);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (/^\d{10,13}$/u.test(value.trim()) && Number.isFinite(numeric)) {
      const parsed = new Date(value.trim().length === 10 ? numeric * 1000 : numeric);
      if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
    }
    const timestamp = Date.parse(value.trim());
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  }
  return fallback;
}

async function getFankeCollectionWindow(
  db: D1Database,
  userId: string,
  kind: FankeFileKind,
): Promise<FankeCollectionWindow | null> {
  const statement = kind === "registration"
    ? db.prepare(`SELECT starts_at, timezone FROM collector_settings WHERE user_id = ?`).bind(userId)
    : kind === "edp"
      ? db.prepare(`SELECT starts_at, timezone FROM edp_settings WHERE user_id = ?`).bind(userId)
      : db.prepare(`SELECT starts_at, timezone FROM media_collector_settings WHERE user_id = ? AND kind = ?`).bind(userId, kind);
  const row = await statement.first<{ starts_at: string | null; timezone: string | null }>();
  const startsAt = normalizeText(row?.starts_at, 10);
  const timezone = normalizeText(row?.timezone, 100) ?? "Asia/Shanghai";
  if (!startsAt || !/^\d{4}-\d{2}-\d{2}$/u.test(startsAt)) return null;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format();
  } catch {
    return null;
  }
  return { startsAt, timezone };
}

function submissionDateInTimezone(submittedAt: string, timezone: string): string | null {
  const submitted = new Date(submittedAt);
  if (!Number.isFinite(submitted.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(submitted);
    const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return null;
  }
}

function isWithinFankeCollectionWindow(submittedAt: string, settings: FankeCollectionWindow): boolean {
  const submittedDate = submissionDateInTimezone(submittedAt, settings.timezone);
  return Boolean(submittedDate && submittedDate >= settings.startsAt);
}

function fankeCollectionStartInstant(settings: FankeCollectionWindow): string {
  const [year, month, day] = settings.startsAt.split("-").map(Number);
  const desiredWallClock = Date.UTC(year, month - 1, day, 0, 0, 0);
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: settings.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  let candidate = desiredWallClock;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(candidate)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
    );
    const renderedWallClock = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second),
    );
    const correction = desiredWallClock - renderedWallClock;
    candidate += correction;
    if (correction === 0) break;
  }
  return new Date(candidate).toISOString();
}

interface FlatEntry { path: string; key: string; value: unknown }

function flatten(value: unknown, output: FlatEntry[], path = "root", depth = 0): void {
  if (depth > 12 || output.length > 10_000) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => flatten(entry, output, `${path}[${index}]`, depth + 1));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output.push({ path: `${path}.${key}`, key, value: entry });
      flatten(entry, output, `${path}.${key}`, depth + 1);
    }
  }
}

function firstField(entries: FlatEntry[], patterns: RegExp[]): unknown {
  for (const pattern of patterns) {
    const found = entries.find((entry) => pattern.test(entry.key) && ["string", "number"].includes(typeof entry.value));
    if (found) return found.value;
  }
  return null;
}

function schoolFromPayload(entries: FlatEntry[], filenames: string[]): string | null {
  const direct = firstField(entries, [/^(?:schoolName|school_name|school)$/iu, /学校|院校|单位|团队名称|队伍名称/u]);
  const normalized = normalizeText(direct, 200);
  let selected = normalized && /大学|学院|学校|中学|University|College|Institute/iu.test(normalized)
    ? normalizeCompetitionSchoolName(normalized)
    : null;
  for (const entry of entries) {
    if (typeof entry.value !== "string" || /(?:filename|fileName|name|url|link)/iu.test(entry.key)) continue;
    const text = normalizeText(entry.value, 200);
    const match = text?.match(/([\p{Script=Han}A-Za-z0-9·＆&()（） -]{2,100}?(?:大学|学院|职业技术学院|研究院|学校|中学))/u);
    if (match?.[1]) selected = preferDetailedCompetitionSchoolName(selected, [match[1]]);
  }
  const filenameSchools: string[] = [];
  for (const filename of filenames) {
    const inferred = inferSchoolNameFromFilename(filename);
    if (inferred) filenameSchools.push(inferred);
  }
  return preferDetailedCompetitionSchoolName(selected, filenameSchools);
}

function fileCandidates(payload: unknown, entries: FlatEntry[]): FileCandidate[] {
  const candidates = new Map<string, FileCandidate>();
  const remember = (candidate: FileCandidate): void => {
    const existing = candidates.get(candidate.url.href);
    if (!existing) {
      candidates.set(candidate.url.href, candidate);
      return;
    }
    candidates.set(candidate.url.href, {
      filename: candidate.filename || existing.filename,
      url: candidate.url,
      fileId: candidate.fileId ?? existing.fileId,
      size: candidate.size ?? existing.size,
      context: `${existing.context} ${candidate.context}`.trim().slice(0, 2_000),
    });
  };
  const visit = (value: unknown, path = "root", depth = 0): void => {
    if (depth > 12) return;
    if (typeof value === "string") {
      const url = trustedDownloadUrl(value);
      const filename = url && filenameFromUrl(url);
      if (url && filename) remember({ filename, url, fileId: null, size: null, context: path });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${index}]`, depth + 1));
      return;
    }
    if (!value || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    const urlValue = object.downloadUrl ?? object.download_url ?? object.fileUrl ?? object.file_url ?? object.url ?? object.link;
    const url = typeof urlValue === "string" ? trustedDownloadUrl(urlValue) : null;
    if (url) {
      const filename = normalizeText(object.filename ?? object.fileName ?? object.file_name ?? object.name, 240) ?? filenameFromUrl(url);
      if (filename) {
        const sizeValue = Number(object.size ?? object.fileSize ?? object.file_size);
        const fileId = normalizeText(object.fileId ?? object.file_id ?? object.id, 300);
        const labels = [object.label, object.title, object.question, object.questionName, object.fieldName, object.key]
          .map((entry) => normalizeText(entry, 300))
          .filter((entry): entry is string => Boolean(entry));
        remember({
          filename,
          url,
          fileId,
          size: Number.isSafeInteger(sizeValue) && sizeValue >= 0 ? sizeValue : null,
          context: `${path} ${Object.keys(object).join(" ")} ${labels.join(" ")}`.slice(0, 2_000),
        });
      }
    }
    Object.entries(object).forEach(([key, entry]) => visit(entry, `${path}.${key}`, depth + 1));
  };
  visit(payload);

  for (const entry of entries) {
    if (typeof entry.value !== "string") continue;
    const matches = entry.value.match(/https:\/\/[^\s"'<>]+/gu) ?? [];
    for (const match of matches) {
      const url = trustedDownloadUrl(match);
      const filename = url && filenameFromUrl(url);
      if (url && filename) remember({ filename, url, fileId: null, size: null, context: `${entry.path} ${entry.key}` });
    }
  }
  return [...candidates.values()];
}

async function parseWebhookPayload(payload: unknown, receivedAt: string, configuredFormId: string | null): Promise<ParsedFile[]> {
  const entries: FlatEntry[] = [];
  flatten(payload, entries);
  const files = fileCandidates(payload, entries);
  if (!files.length) return [];

  const schoolName = schoolFromPayload(entries, files.map((file) => file.filename));
  if (!schoolName) return [];
  const formId = normalizeText(firstField(entries, [/^formId$/iu, /^form_id$/iu, /siteFormId/iu]), 100) ?? configuredFormId;
  const payloadFingerprint = await sha256Hex(JSON.stringify(payload));
  const submissionId = normalizeText(firstField(entries, [/^submissionId$/iu, /^submitId$/iu, /^recordId$/iu, /^submit_id$/iu]), 200)
    ?? normalizeText(firstField(entries, [/^id$/iu]), 200)
    ?? `event-${payloadFingerprint.slice(0, 24)}`;
  const submittedValue = firstField(entries, [/^submittedAt$/iu, /^submitTime$/iu, /^submit_time$/iu, /^createTime$/iu, /^time$/iu]);
  const submittedAt = parseDateValue(submittedValue, receivedAt);

  return files.flatMap((file) => {
    const kind = classifyFankeCandidate(file.filename, file.context);
    if (!kind) return [];
    return [{
      formId,
      submissionId,
      submittedAt,
      schoolName,
      fileId: file.fileId,
      filename: file.filename,
      downloadUrl: file.url.href,
      size: file.size,
      kind,
    }];
  });
}

async function readWebhookBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_WEBHOOK_BYTES) {
        await reader.cancel("body too large");
        throw new Error("body_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const text = decoder.decode(bytes).trim();
  if (!text) return {};
  const contentType = request.headers.get("Content-Type")?.toLocaleLowerCase("en-US") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(text);
    const object: Record<string, unknown> = {};
    for (const [key, value] of params) {
      let parsedValue: unknown = value;
      const trimmedValue = value.trimStart();
      if (trimmedValue.startsWith("[") || trimmedValue.startsWith("{")) {
        try { parsedValue = JSON.parse(value) as unknown; } catch { /* Keep the original string. */ }
      }
      if (key in object) object[key] = Array.isArray(object[key]) ? [...object[key] as unknown[], parsedValue] : [object[key], parsedValue];
      else object[key] = parsedValue;
    }
    return object;
  }
  try { return JSON.parse(text) as unknown; } catch { return { rawText: text }; }
}

export async function ensureFankeSchema(db: D1Database): Promise<void> {
  const key = db as unknown as object;
  const cached = schemaPromises.get(key);
  if (cached) return cached;
  const pending = (async () => {
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS fanke_connectors (
        user_id TEXT PRIMARY KEY NOT NULL, form_id TEXT, secret_hash TEXT NOT NULL UNIQUE,
        secret_prefix TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        last_event_at TEXT, last_processed_at TEXT, last_error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS fanke_files (
        user_id TEXT NOT NULL, queue_id TEXT NOT NULL, form_id TEXT, submission_id TEXT NOT NULL,
        submitted_at TEXT NOT NULL, school_name TEXT NOT NULL, file_id TEXT, filename TEXT NOT NULL,
        download_url TEXT NOT NULL, size INTEGER, kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', source TEXT NOT NULL DEFAULT 'webhook',
        attempt_count INTEGER NOT NULL DEFAULT 0, claim_token TEXT, last_attempt_at TEXT,
        next_attempt_at TEXT, last_error TEXT, received_at TEXT NOT NULL,
        processed_at TEXT, updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, queue_id),
        CHECK (kind IN ('registration','edp','poster','video')),
        CHECK (status IN ('pending','processing','retry','processed','ignored','invalid'))
      )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_fanke_files_due ON fanke_files (user_id, kind, status, next_attempt_at, received_at)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_fanke_files_submission ON fanke_files (user_id, submission_id, kind)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS fanke_issues (
        user_id TEXT NOT NULL, issue_id TEXT NOT NULL, form_id TEXT, submission_id TEXT,
        school_name TEXT, reason_code TEXT NOT NULL, message TEXT NOT NULL,
        received_at TEXT NOT NULL, PRIMARY KEY (user_id, issue_id)
      )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_fanke_issues_user_received ON fanke_issues (user_id, received_at)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS fanke_assistant_submissions (
        user_id TEXT NOT NULL, form_id TEXT NOT NULL, submission_id TEXT NOT NULL,
        revision_hash TEXT NOT NULL, revision_number INTEGER NOT NULL DEFAULT 1,
        submitted_at TEXT NOT NULL, updated_at TEXT, school_name TEXT NOT NULL,
        file_count INTEGER NOT NULL DEFAULT 0, classified_count INTEGER NOT NULL DEFAULT 0,
        first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, last_changed_at TEXT NOT NULL,
        PRIMARY KEY (user_id, form_id, submission_id)
      )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_fanke_assistant_submissions_seen
        ON fanke_assistant_submissions (user_id, form_id, last_seen_at)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS fanke_assistant_files (
        user_id TEXT NOT NULL, form_id TEXT NOT NULL, submission_id TEXT NOT NULL,
        file_key TEXT NOT NULL, fingerprint TEXT NOT NULL, file_id TEXT,
        filename TEXT NOT NULL, download_url TEXT NOT NULL, size INTEGER,
        context TEXT, kind TEXT, last_seen_at TEXT NOT NULL,
        PRIMARY KEY (user_id, form_id, submission_id, file_key),
        CHECK (kind IS NULL OR kind IN ('registration','edp','poster','video'))
      )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_fanke_assistant_files_submission
        ON fanke_assistant_files (user_id, form_id, submission_id)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS fanke_assistant_runs (
        user_id TEXT PRIMARY KEY NOT NULL, form_id TEXT NOT NULL, scan_id TEXT NOT NULL,
        target_kind TEXT NOT NULL DEFAULT 'registration',
        status TEXT NOT NULL DEFAULT 'running', total_records INTEGER NOT NULL DEFAULT 0,
        new_records INTEGER NOT NULL DEFAULT 0, changed_records INTEGER NOT NULL DEFAULT 0,
        unchanged_records INTEGER NOT NULL DEFAULT 0, queued_files INTEGER NOT NULL DEFAULT 0,
        unclassified_files INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL,
        completed_at TEXT, last_error TEXT, updated_at TEXT NOT NULL,
        CHECK (status IN ('running','completed','failed')),
        CHECK (target_kind IN ('registration','edp','poster','video'))
      )`),
    ]);
    const runColumns = await db.prepare(`PRAGMA table_info(fanke_assistant_runs)`).all<{ name: string }>();
    if (!runColumns.results.some((column) => column.name === "target_kind")) {
      await db.prepare(`ALTER TABLE fanke_assistant_runs ADD COLUMN target_kind TEXT NOT NULL DEFAULT 'registration'
        CHECK (target_kind IN ('registration','edp','poster','video'))`).run();
    }
  })();
  schemaPromises.set(key, pending);
  try { await pending; } catch (error) { schemaPromises.delete(key); throw error; }
}

async function connectorBySecret(db: D1Database, secret: string): Promise<{ user_id: string; form_id: string | null } | null> {
  const secretHash = await sha256Hex(`chemecar-fanke-webhook-v1:${secret}`);
  return db.prepare(`SELECT user_id, form_id FROM fanke_connectors WHERE secret_hash = ? AND enabled = 1`).bind(secretHash)
    .first<{ user_id: string; form_id: string | null }>();
}

async function recordIssue(
  db: D1Database,
  userId: string,
  input: { formId?: string | null; submissionId?: string | null; schoolName?: string | null; reasonCode: string; message: string; receivedAt: string },
): Promise<void> {
  const issueId = await sha256Hex(`${userId}\0${input.receivedAt}\0${input.reasonCode}\0${crypto.randomUUID()}`);
  await db.prepare(`INSERT INTO fanke_issues (
    user_id, issue_id, form_id, submission_id, school_name, reason_code, message, received_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(userId, issueId, input.formId ?? null, input.submissionId ?? null, input.schoolName ?? null, input.reasonCode, input.message, input.receivedAt).run();
}

export async function handleFankeWebhook(
  request: Request,
  env: FankeCollectorEnv,
  secret: string,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  if (!/^[A-Za-z0-9_-]{40,80}$/u.test(secret)) return responseJson({ ok: false }, 404);
  await ensureFankeSchema(env.DB);
  const connector = await connectorBySecret(env.DB, secret);
  if (!connector) return responseJson({ ok: false }, 404);
  const receivedAt = new Date().toISOString();
  let payload: unknown;
  try {
    payload = await readWebhookBody(request);
  } catch (error) {
    if (error instanceof Error && error.message === "body_too_large") {
      await recordIssue(env.DB, connector.user_id, { formId: connector.form_id, reasonCode: "payload_too_large", message: "凡科推送内容超过 2MB，未进入采集队列。", receivedAt });
      return responseJson({ ok: false, error: { code: "payload_too_large", message: "推送内容过大。" } }, 413);
    }
    throw error;
  }

  const parsedFiles = await parseWebhookPayload(payload, receivedAt, connector.form_id);
  if (!parsedFiles.length) {
    const entries: FlatEntry[] = [];
    flatten(payload, entries);
    const inferredSchool = schoolFromPayload(entries, []);
    await recordIssue(env.DB, connector.user_id, {
      formId: connector.form_id,
      schoolName: inferredSchool,
      reasonCode: "unrecognized_payload",
      message: "已收到凡科推送，但未识别到受支持的文件下载地址或文件格式。请在控制台查看并重新测试推送。",
      receivedAt,
    });
    await env.DB.prepare(`UPDATE fanke_connectors SET last_event_at = ?, last_error = ?, updated_at = ? WHERE user_id = ?`)
      .bind(receivedAt, "推送中未识别到可收集文件。", receivedAt, connector.user_id).run();
    return responseJson({ ok: true, accepted: 0, issues: 1 }, 202);
  }

  let accepted = 0;
  for (const file of parsedFiles) {
    const queueId = await sha256Hex([
      connector.user_id, file.formId ?? "", file.submissionId, file.schoolName, file.fileId ?? "", file.downloadUrl, file.kind,
    ].join("\0"));
    const result = await env.DB.prepare(`INSERT INTO fanke_files (
      user_id, queue_id, form_id, submission_id, submitted_at, school_name, file_id,
      filename, download_url, size, kind, status, source, attempt_count,
      received_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'webhook', 0, ?, ?)
    ON CONFLICT(user_id, queue_id) DO UPDATE SET
      form_id = excluded.form_id, submission_id = excluded.submission_id,
      submitted_at = excluded.submitted_at, school_name = excluded.school_name,
      file_id = excluded.file_id, filename = excluded.filename, download_url = excluded.download_url,
      size = excluded.size, status = CASE WHEN fanke_files.status IN ('processed','invalid') THEN fanke_files.status ELSE 'pending' END,
      next_attempt_at = NULL, last_error = NULL, updated_at = excluded.updated_at`)
      .bind(
        connector.user_id, queueId, file.formId, file.submissionId, file.submittedAt,
        file.schoolName, file.fileId, file.filename, file.downloadUrl, file.size,
        file.kind, receivedAt, receivedAt,
      ).run();
    if (result.success) accepted += 1;
  }
  await env.DB.prepare(`UPDATE fanke_connectors SET last_event_at = ?, last_error = NULL, updated_at = ? WHERE user_id = ?`)
    .bind(receivedAt, receivedAt, connector.user_id).run();
  return responseJson({ ok: true, accepted }, 202);
}

function assistantString(object: Record<string, unknown>, keys: string[], maximum: number): string | null {
  for (const key of keys) {
    const value = normalizeText(object[key], maximum);
    if (value) return value;
  }
  return null;
}

async function normalizeAssistantRecord(value: unknown): Promise<AssistantInputRecord | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  const submissionId = assistantString(object, ["submissionId", "submitId", "recordId", "id"], 200);
  const submittedAt = parseDateValue(object.submittedAt ?? object.submitTime ?? object.createdAt, "");
  const updatedAtValue = object.updatedAt ?? object.updateTime ?? object.modifiedAt;
  const updatedAt = updatedAtValue === undefined || updatedAtValue === null || updatedAtValue === ""
    ? null
    : parseDateValue(updatedAtValue, "");
  const rawFiles = Array.isArray(object.files) ? object.files.slice(0, 40) : [];
  const files: AssistantInputFile[] = [];
  for (const rawFile of rawFiles) {
    if (!rawFile || typeof rawFile !== "object" || Array.isArray(rawFile)) continue;
    const file = rawFile as Record<string, unknown>;
    const urlValue = assistantString(file, ["downloadUrl", "download_url", "fileUrl", "url", "href"], 4096);
    const url = urlValue ? trustedDownloadUrl(urlValue) : null;
    if (!url) continue;
    const filename = assistantString(file, ["filename", "fileName", "name", "title"], 240) ?? filenameFromUrl(url);
    if (!filename || isFankePreviewImage(filename, url)) continue;
    const fileId = assistantString(file, ["fileId", "file_id", "id"], 300);
    const context = [file.label, file.fieldLabel, file.question, file.questionName, file.context, file.title]
      .map((entry) => normalizeText(entry, 300))
      .filter((entry): entry is string => Boolean(entry))
      .join(" ")
      .slice(0, 1_000);
    const sizeValue = Number(file.size ?? file.fileSize ?? file.file_size);
    const size = Number.isSafeInteger(sizeValue) && sizeValue > 0 ? sizeValue : null;
    const isFileView = /\/view\.jsp$/iu.test(url.pathname) && Boolean(url.searchParams.get("fileID"));
    const kind = isFileView ? classifyFankeFile(filename) : classifyFankeCandidate(filename, context);
    const fileKey = await sha256Hex(fileId ? `id\0${fileId}` : `slot\0${context}\0${filename}`);
    const fingerprint = await sha256Hex(fileId
      ? [fileId, filename, size ?? "", context, kind ?? ""].join("\0")
      : [filename, assistantUrlIdentity(url), size ?? "", context, kind ?? ""].join("\0"));
    files.push({ fileId, filename, downloadUrl: url.href, size, context, kind, fileKey, fingerprint });
  }
  const directSchoolName = normalizedAssistantSchoolName(assistantString(object, ["schoolName", "school", "university", "teamName"], 200));
  const filenameSchools = files
    .map((file) => inferSchoolNameFromFilename(file.filename))
    .filter((value): value is string => Boolean(value));
  const schoolName = preferDetailedCompetitionSchoolName(directSchoolName, filenameSchools);
  if (!submissionId || !submittedAt || !schoolName) return null;
  const stableFiles = files.map((file) => `${file.fileKey}:${file.fingerprint}`).sort();
  const revisionHash = await sha256Hex([submissionId, submittedAt, updatedAt ?? "", schoolName, ...stableFiles].join("\0"));
  return { submissionId, submittedAt, updatedAt, schoolName, revisionHash, files };
}

async function readAssistantPayload(request: Request): Promise<Record<string, unknown> | null> {
  if (!request.headers.get("Content-Type")?.toLocaleLowerCase("en-US").includes("application/json")) return null;
  const payload = await readWebhookBody(request);
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : null;
}

function assistantTargetKind(value: unknown): FankeCollectibleKind | null {
  return parseFankeCollectibleKind(value);
}

function assistantScopeFormId(formId: string, kind: FankeCollectibleKind): string {
  return `${formId}#${kind}`;
}

async function assistantRevisionHash(record: AssistantInputRecord, files: AssistantInputFile[]): Promise<string> {
  const stableFiles = files.map((file) => `${file.fileKey}:${file.fingerprint}`).sort();
  return sha256Hex([
    record.submissionId,
    record.submittedAt,
    record.updatedAt ?? "",
    record.schoolName,
    ...stableFiles,
  ].join("\0"));
}

function compareSubmittedAt(left: string, right: string): number {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime > rightTime ? 1 : -1;
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

function normalizedSchoolVersionMap<T extends StoredLibraryVersionRow>(
  rows: T[],
  value: (row: T) => QueuedSchoolVersion,
): Map<string, QueuedSchoolVersion> {
  const versions = new Map<string, QueuedSchoolVersion>();
  for (const row of rows) {
    const schoolName = normalizeCompetitionSchoolName(row.school_name);
    if (!schoolName) continue;
    const candidate = value(row);
    const current = versions.get(schoolName);
    if (!current || compareSubmittedAt(candidate.submittedAt, current.submittedAt) > 0) versions.set(schoolName, candidate);
  }
  return versions;
}

async function storedLibraryVersions(
  db: D1Database,
  userId: string,
  kind: FankeFileKind,
): Promise<Map<string, QueuedSchoolVersion>> {
  let rows: StoredLibraryVersionRow[];
  if (kind === "registration") {
    rows = (await db.prepare(`SELECT school_name, submitted_at FROM collector_registrations WHERE user_id = ?`)
      .bind(userId).all<StoredLibraryVersionRow>()).results;
  } else if (kind === "edp") {
    rows = (await db.prepare(`SELECT school_name, submitted_at FROM edp_submissions WHERE user_id = ?`)
      .bind(userId).all<StoredLibraryVersionRow>()).results;
  } else {
    rows = (await db.prepare(`SELECT school_name, submitted_at FROM shared_media_assets WHERE user_id = ? AND kind = ?`)
      .bind(userId, kind).all<StoredLibraryVersionRow>()).results;
  }
  return normalizedSchoolVersionMap(rows, (row) => ({ submittedAt: row.submitted_at, submissionId: "" }));
}

async function queuedSchoolVersions(
  db: D1Database,
  userId: string,
  formId: string,
  kind: FankeFileKind,
): Promise<Map<string, QueuedSchoolVersion>> {
  const rows = await db.prepare(`SELECT school_name, submitted_at, submission_id FROM fanke_files
    WHERE user_id = ? AND form_id = ? AND kind = ? AND source = 'assistant'
      AND status IN ('pending','processing','retry','invalid')`)
    .bind(userId, formId, kind).all<QueuedSchoolVersionRow>();
  return normalizedSchoolVersionMap(rows.results, (row) => ({
    submittedAt: row.submitted_at,
    submissionId: row.submission_id,
  }));
}

async function removeQueuesCoveredByLibrary(
  db: D1Database,
  userId: string,
  formId: string,
  kind: FankeFileKind,
): Promise<void> {
  const sharedPredicate = `fanke_files.user_id = ? AND fanke_files.form_id = ? AND fanke_files.kind = ?
    AND fanke_files.source = 'assistant' AND fanke_files.status != 'processed'`;
  const sql = kind === "registration"
    ? `DELETE FROM fanke_files WHERE ${sharedPredicate} AND EXISTS (
        SELECT 1 FROM collector_registrations AS stored
        WHERE stored.user_id = fanke_files.user_id AND stored.school_name = fanke_files.school_name
          AND stored.submitted_at >= fanke_files.submitted_at
      )`
    : kind === "edp"
      ? `DELETE FROM fanke_files WHERE ${sharedPredicate} AND EXISTS (
          SELECT 1 FROM edp_submissions AS stored
          WHERE stored.user_id = fanke_files.user_id AND stored.school_name = fanke_files.school_name
            AND stored.submitted_at >= fanke_files.submitted_at
        )`
      : `DELETE FROM fanke_files WHERE ${sharedPredicate} AND EXISTS (
          SELECT 1 FROM shared_media_assets AS stored
          WHERE stored.user_id = fanke_files.user_id AND stored.kind = fanke_files.kind
            AND stored.school_name = fanke_files.school_name
            AND stored.submitted_at >= fanke_files.submitted_at
        )`;
  await db.prepare(sql).bind(userId, formId, kind).run();
}

export async function startFankeAssistantScan(
  request: Request,
  env: FankeCollectorEnv,
  userId: string,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  await ensureFankeSchema(env.DB);
  const body = await readAssistantPayload(request);
  if (!body) return responseJson({ ok: false, error: { code: "invalid_json", message: "采集任务参数必须使用 JSON 格式。" } }, 400);
  const scanId = assistantString(body, ["scanId"], 100);
  const formId = assistantString(body, ["formId"], 100);
  if (body.targetKind === "poster" || body.targetKind === "video") {
    return responseJson({ ok: false, error: { code: "unsupported_fanke_kind", message: "凡科只采集报名表和 EDP；海报和视频请使用阿里邮箱采集。" } }, 400);
  }
  const targetKind = assistantTargetKind(body.targetKind);
  if (!scanId || !formId || !targetKind) return responseJson({ ok: false, error: { code: "invalid_scan", message: "缺少采集任务编号、凡科表单编号或目标栏目。" } }, 400);
  const collectionWindow = await getFankeCollectionWindow(env.DB, userId, targetKind);
  if (!collectionWindow) {
    return responseJson({
      ok: false,
      error: { code: "start_date_required", message: "请先在当前栏目设置并保存收集起始日期。" },
    }, 400);
  }
  const now = new Date().toISOString();
  const cutoffInstant = fankeCollectionStartInstant(collectionWindow);
  const scopeFormId = assistantScopeFormId(formId, targetKind);
  await env.DB.prepare(`UPDATE fanke_assistant_submissions AS submission
    SET revision_hash = ?
    WHERE submission.user_id = ? AND submission.form_id = ? AND (
      submission.submitted_at < ? OR EXISTS (
        SELECT 1 FROM fanke_assistant_files AS file
        WHERE file.user_id = submission.user_id AND file.form_id = submission.form_id
          AND file.submission_id = submission.submission_id
          AND file.download_url LIKE '%/view.jsp?fileID=%'
      )
    )`).bind(`stale:${scanId}`, userId, scopeFormId, cutoffInstant).run();
  await env.DB.prepare(`DELETE FROM fanke_assistant_files AS file
    WHERE file.user_id = ? AND file.form_id = ? AND (
      file.download_url LIKE '%/view.jsp?fileID=%' OR EXISTS (
        SELECT 1 FROM fanke_assistant_submissions AS submission
        WHERE submission.user_id = file.user_id AND submission.form_id = file.form_id
          AND submission.submission_id = file.submission_id AND submission.submitted_at < ?
      )
    )`).bind(userId, scopeFormId, cutoffInstant).run();
  const staleQueue = await env.DB.prepare(`DELETE FROM fanke_files
    WHERE user_id = ? AND kind = ? AND source = 'assistant' AND status != 'processed'
      AND (submitted_at < ? OR download_url LIKE '%/view.jsp?fileID=%')`)
    .bind(userId, targetKind, cutoffInstant).run();
  await env.DB.prepare(`UPDATE fanke_files SET status = 'pending', next_attempt_at = NULL,
    last_error = NULL, claim_token = NULL, updated_at = ?
    WHERE user_id = ? AND kind = ? AND source = 'assistant' AND status IN ('retry','invalid')
      AND submitted_at >= ?`).bind(now, userId, targetKind, cutoffInstant).run();
  await env.DB.prepare(`INSERT INTO fanke_assistant_runs (
    user_id, form_id, scan_id, target_kind, status, total_records, new_records, changed_records,
    unchanged_records, queued_files, unclassified_files, started_at, completed_at,
    last_error, updated_at
  ) VALUES (?, ?, ?, ?, 'running', 0, 0, 0, 0, 0, 0, ?, NULL, NULL, ?)
  ON CONFLICT(user_id) DO UPDATE SET form_id = excluded.form_id, scan_id = excluded.scan_id,
    target_kind = excluded.target_kind,
    status = 'running', total_records = 0, new_records = 0, changed_records = 0,
    unchanged_records = 0, queued_files = 0, unclassified_files = 0,
    started_at = excluded.started_at, completed_at = NULL, last_error = NULL, updated_at = excluded.updated_at`)
    .bind(userId, formId, scanId, targetKind, now, now).run();
  return responseJson({
    ok: true,
    scanId,
    formId,
    targetKind,
    startedAt: now,
    startsAt: collectionWindow.startsAt,
    timezone: collectionWindow.timezone,
    removedStaleQueue: Number(staleQueue.meta.changes ?? 0),
  });
}

export async function ingestFankeAssistantBatch(
  request: Request,
  env: FankeCollectorEnv,
  userId: string,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  await ensureFankeSchema(env.DB);
  const body = await readAssistantPayload(request);
  if (!body) return responseJson({ ok: false, error: { code: "invalid_json", message: "采集批次必须使用 JSON 格式。" } }, 400);
  const scanId = assistantString(body, ["scanId"], 100);
  const formId = assistantString(body, ["formId"], 100);
  if (body.targetKind === "poster" || body.targetKind === "video") {
    return responseJson({ ok: false, error: { code: "unsupported_fanke_kind", message: "凡科只采集报名表和 EDP；海报和视频请使用阿里邮箱采集。" } }, 400);
  }
  const targetKind = assistantTargetKind(body.targetKind);
  const rawRecords = Array.isArray(body.records) ? body.records : null;
  if (!scanId || !formId || !targetKind || !rawRecords || rawRecords.length > MAX_ASSISTANT_RECORDS) {
    return responseJson({ ok: false, error: { code: "invalid_batch", message: `每个采集批次最多包含 ${MAX_ASSISTANT_RECORDS} 条记录。` } }, 400);
  }
  const activeRun = await env.DB.prepare(`SELECT scan_id, target_kind FROM fanke_assistant_runs
    WHERE user_id = ? AND form_id = ? AND status = 'running'`).bind(userId, formId)
    .first<{ scan_id: string; target_kind: FankeCollectibleKind }>();
  if (activeRun?.scan_id !== scanId || activeRun.target_kind !== targetKind) {
    return responseJson({ ok: false, error: { code: "scan_replaced", message: "该采集任务已被另一台电脑上的新任务替换。" } }, 409);
  }

  const collectionWindow = await getFankeCollectionWindow(env.DB, userId, targetKind);
  if (!collectionWindow) {
    return responseJson({ ok: false, error: { code: "start_date_required", message: "当前栏目的收集起始日期已被清空，请重新设置后再采集。" } }, 400);
  }

  const scopeFormId = assistantScopeFormId(formId, targetKind);
  const storedVersions = await storedLibraryVersions(env.DB, userId, targetKind);
  await removeQueuesCoveredByLibrary(env.DB, userId, formId, targetKind);
  const pendingVersions = await queuedSchoolVersions(env.DB, userId, formId, targetKind);
  const summary = { received: rawRecords.length, outsideDate: 0, skippedOtherKinds: 0, newRecords: 0, changedRecords: 0, unchangedRecords: 0, queuedFiles: 0, unclassifiedFiles: 0, invalidRecords: 0 };
  for (const rawRecord of rawRecords) {
    const record = await normalizeAssistantRecord(rawRecord);
    if (!record) {
      summary.invalidRecords += 1;
      continue;
    }
    if (!isWithinFankeCollectionWindow(record.submittedAt, collectionWindow)) {
      summary.outsideDate += 1;
      continue;
    }
    const targetFiles: AssistantInputFile[] = record.files.flatMap((file) => {
      if (file.kind === targetKind) return [file];
      // A generic archive can be a valid EDP (for example “华东理工大学.7z”).
      // Only the EDP validator can identify it reliably from its contents.
      if (targetKind === "edp" && file.kind === null && /\.(?:zip|7z|rar)$/iu.test(file.filename)) {
        return [{ ...file, kind: "edp" as const }];
      }
      return [];
    });
    if (targetFiles.length === 0) {
      summary.skippedOtherKinds += 1;
      continue;
    }
    const targetRecord: AssistantInputRecord = {
      ...record,
      files: targetFiles,
      revisionHash: await assistantRevisionHash(record, targetFiles),
    };
    const now = new Date().toISOString();
    const current = await env.DB.prepare(`SELECT revision_hash, revision_number, submitted_at, school_name
      FROM fanke_assistant_submissions WHERE user_id = ? AND form_id = ? AND submission_id = ?`)
      .bind(userId, scopeFormId, targetRecord.submissionId).first<AssistantSubmissionRow>();
    const unchangedRevision = current?.revision_hash === targetRecord.revisionHash;
    const previousVersionSubmissionId = current
      ? `${targetRecord.submissionId}-${targetKind}-r${String(current.revision_number).padStart(12, "0")}`
      : null;
    const storedVersion = storedVersions.get(targetRecord.schoolName);
    const pendingVersion = pendingVersions.get(targetRecord.schoolName);
    const storedComparison = storedVersion ? compareSubmittedAt(storedVersion.submittedAt, targetRecord.submittedAt) : -1;
    const pendingComparison = pendingVersion ? compareSubmittedAt(pendingVersion.submittedAt, targetRecord.submittedAt) : -1;
    const storedCoversRecord = Boolean(storedVersion) && (current
      ? unchangedRevision ? storedComparison >= 0 : storedComparison > 0
      : storedComparison >= 0);
    const pendingIsPreviousRevision = Boolean(
      previousVersionSubmissionId && pendingVersion?.submissionId === previousVersionSubmissionId,
    );
    const pendingCoversRecord = Boolean(pendingVersion)
      && pendingComparison >= 0
      && !(current && !unchangedRevision && pendingIsPreviousRevision);
    const shouldQueueRecord = !storedCoversRecord && !pendingCoversRecord;
    const restoreMissingFile = Boolean(unchangedRevision && shouldQueueRecord);
    if (unchangedRevision && !restoreMissingFile) {
      await env.DB.batch([
        env.DB.prepare(`UPDATE fanke_assistant_submissions SET last_seen_at = ?
          WHERE user_id = ? AND form_id = ? AND submission_id = ?`)
          .bind(now, userId, scopeFormId, targetRecord.submissionId),
        env.DB.prepare(`UPDATE fanke_assistant_runs SET total_records = total_records + 1,
          unchanged_records = unchanged_records + 1, updated_at = ?
          WHERE user_id = ? AND scan_id = ? AND status = 'running'`).bind(now, userId, scanId),
      ]);
      summary.unchangedRecords += 1;
      continue;
    }

    const previousFiles = current
      ? await env.DB.prepare(`SELECT file_key, fingerprint FROM fanke_assistant_files
          WHERE user_id = ? AND form_id = ? AND submission_id = ?`)
        .bind(userId, scopeFormId, targetRecord.submissionId).all<AssistantFileRow>()
      : { results: [] as AssistantFileRow[] };
    const previousByKey = new Map(previousFiles.results.map((file) => [file.file_key, file.fingerprint]));
    const metadataChanged = Boolean(current && (current.submitted_at !== targetRecord.submittedAt || current.school_name !== targetRecord.schoolName));
    const revisionNumber = (current?.revision_number ?? 0) + 1;
    const versionSubmissionId = `${targetRecord.submissionId}-${targetKind}-r${String(revisionNumber).padStart(12, "0")}`;
    const statements = [
      env.DB.prepare(`DELETE FROM fanke_assistant_files WHERE user_id = ? AND form_id = ? AND submission_id = ?`)
        .bind(userId, scopeFormId, targetRecord.submissionId),
    ];
    let queuedForRecord = 0;
    let queueCleanupAdded = false;
    const unclassifiedForRecord = 0;
    for (const file of targetRecord.files) {
      statements.push(env.DB.prepare(`INSERT INTO fanke_assistant_files (
        user_id, form_id, submission_id, file_key, fingerprint, file_id, filename,
        download_url, size, context, kind, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(userId, scopeFormId, targetRecord.submissionId, file.fileKey, file.fingerprint, file.fileId,
          file.filename, file.downloadUrl, file.size, file.context || null, file.kind, now));
      if (!shouldQueueRecord) continue;
      if (!restoreMissingFile && !metadataChanged && previousByKey.get(file.fileKey) === file.fingerprint) continue;
      if (!queueCleanupAdded) {
        if (previousVersionSubmissionId) {
          statements.push(env.DB.prepare(`DELETE FROM fanke_files
            WHERE user_id = ? AND form_id = ? AND submission_id = ? AND kind = ?
              AND source = 'assistant' AND status != 'processed'`)
            .bind(userId, formId, previousVersionSubmissionId, targetKind));
        }
        statements.push(env.DB.prepare(`DELETE FROM fanke_files
          WHERE user_id = ? AND form_id = ? AND kind = ? AND school_name = ?
            AND source = 'assistant' AND status != 'processed'
            AND (submitted_at < ? OR (submitted_at = ? AND submission_id != ?))`)
          .bind(userId, formId, targetKind, targetRecord.schoolName,
            targetRecord.submittedAt, targetRecord.submittedAt, versionSubmissionId));
        queueCleanupAdded = true;
      }
      const queueId = await sha256Hex([userId, scopeFormId, versionSubmissionId, file.fileKey, targetRecord.revisionHash, targetKind].join("\0"));
      statements.push(env.DB.prepare(`INSERT INTO fanke_files (
        user_id, queue_id, form_id, submission_id, submitted_at, school_name, file_id,
        filename, download_url, size, kind, status, source, attempt_count, received_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'assistant', 0, ?, ?)
      ON CONFLICT(user_id, queue_id) DO UPDATE SET status = CASE
        WHEN fanke_files.status IN ('processed','invalid') THEN fanke_files.status ELSE 'pending' END,
        next_attempt_at = NULL, last_error = NULL, updated_at = excluded.updated_at`)
        .bind(userId, queueId, formId, versionSubmissionId, targetRecord.submittedAt, targetRecord.schoolName,
          file.fileId, file.filename, file.downloadUrl, file.size, targetKind, now, now));
      queuedForRecord += 1;
    }
    statements.push(env.DB.prepare(`INSERT INTO fanke_assistant_submissions (
      user_id, form_id, submission_id, revision_hash, revision_number, submitted_at,
      updated_at, school_name, file_count, classified_count, first_seen_at, last_seen_at, last_changed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, form_id, submission_id) DO UPDATE SET
      revision_hash = excluded.revision_hash, revision_number = excluded.revision_number,
      submitted_at = excluded.submitted_at, updated_at = excluded.updated_at,
      school_name = excluded.school_name, file_count = excluded.file_count,
      classified_count = excluded.classified_count, last_seen_at = excluded.last_seen_at,
      last_changed_at = excluded.last_changed_at`)
      .bind(userId, scopeFormId, targetRecord.submissionId, targetRecord.revisionHash, revisionNumber,
        targetRecord.submittedAt, targetRecord.updatedAt, targetRecord.schoolName, targetRecord.files.length,
        targetRecord.files.length, now, now, now));
    statements.push(env.DB.prepare(`UPDATE fanke_assistant_runs SET total_records = total_records + 1,
      new_records = new_records + ?, changed_records = changed_records + ?, queued_files = queued_files + ?,
      unclassified_files = unclassified_files + ?, updated_at = ?
      WHERE user_id = ? AND scan_id = ? AND status = 'running'`)
      .bind(current ? 0 : 1, current ? 1 : 0, queuedForRecord, unclassifiedForRecord, now, userId, scanId));
    await env.DB.batch(statements);
    if (queuedForRecord > 0) {
      pendingVersions.set(targetRecord.schoolName, {
        submittedAt: targetRecord.submittedAt,
        submissionId: versionSubmissionId,
      });
    }
    if (current) summary.changedRecords += 1;
    else summary.newRecords += 1;
    summary.queuedFiles += queuedForRecord;
    summary.unclassifiedFiles += unclassifiedForRecord;
  }
  return responseJson({ ok: true, scanId, formId, targetKind, ...summary });
}

export async function finishFankeAssistantScan(
  request: Request,
  env: FankeCollectorEnv,
  userId: string,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  await ensureFankeSchema(env.DB);
  const body = await readAssistantPayload(request);
  const scanId = body ? assistantString(body, ["scanId"], 100) : null;
  const errorMessage = body ? assistantString(body, ["error"], 500) : null;
  if (!scanId) return responseJson({ ok: false, error: { code: "invalid_scan", message: "缺少采集任务编号。" } }, 400);
  const now = new Date().toISOString();
  const changed = await env.DB.prepare(`UPDATE fanke_assistant_runs SET status = ?, completed_at = ?,
    last_error = ?, updated_at = ? WHERE user_id = ? AND scan_id = ? AND status = 'running'`)
    .bind(errorMessage ? "failed" : "completed", now, errorMessage, now, userId, scanId).run();
  if ((changed.meta.changes ?? 0) !== 1) {
    return responseJson({ ok: false, error: { code: "scan_replaced", message: "该采集任务已结束或已被新任务替换。" } }, 409);
  }
  const run = await env.DB.prepare(`SELECT form_id, scan_id, target_kind, status, total_records, new_records,
    changed_records, unchanged_records, queued_files, unclassified_files, started_at,
    completed_at, last_error FROM fanke_assistant_runs WHERE user_id = ?`).bind(userId).first<Record<string, unknown>>();
  return responseJson({ ok: true, run });
}

export async function configureFankeConnector(request: Request, env: FankeCollectorEnv, userId: string): Promise<Response> {
  await ensureFankeSchema(env.DB);
  if (request.method === "DELETE") {
    await env.DB.prepare(`UPDATE fanke_connectors SET enabled = 0, updated_at = ? WHERE user_id = ?`)
      .bind(new Date().toISOString(), userId).run();
    return responseJson({ ok: true, connected: false });
  }
  if (request.method !== "POST") return methodNotAllowed(["POST", "DELETE"]);
  let formId: string | null = null;
  if (request.headers.get("Content-Type")?.toLocaleLowerCase("en-US").includes("application/json")) {
    const body = await request.json().catch(() => null);
    if (body && typeof body === "object" && !Array.isArray(body)) {
      formId = normalizeText((body as Record<string, unknown>).formId, 100);
    }
  }
  const secret = randomToken();
  const secretHash = await sha256Hex(`chemecar-fanke-webhook-v1:${secret}`);
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO fanke_connectors (
    user_id, form_id, secret_hash, secret_prefix, enabled, created_at, updated_at
  ) VALUES (?, ?, ?, ?, 1, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET form_id = excluded.form_id, secret_hash = excluded.secret_hash,
    secret_prefix = excluded.secret_prefix, enabled = 1, last_error = NULL, updated_at = excluded.updated_at`)
    .bind(userId, formId, secretHash, secret.slice(0, 8), now, now).run();
  const url = new URL(request.url);
  const webhookUrl = `${url.origin}/api/fanke/webhook/${secret}`;
  return responseJson({
    ok: true,
    connected: true,
    webhookUrl,
    formId,
    message: "接入地址已生成。为安全起见，刷新页面后不会再次显示完整地址；凡科中已保存的地址仍可继续使用。",
  }, 201);
}

function queueFileFromRow(row: QueueRow): FankeQueueFile {
  return {
    queueId: row.queue_id,
    formId: row.form_id,
    submissionId: row.submission_id,
    submittedAt: row.submitted_at,
    schoolName: row.school_name,
    fileId: row.file_id,
    filename: row.filename,
    downloadUrl: row.download_url,
    size: row.size,
    kind: row.kind,
    attemptCount: row.attempt_count,
  };
}

export async function getFankeDashboard(env: FankeCollectorEnv, userId: string): Promise<Record<string, unknown>> {
  await ensureFankeSchema(env.DB);
  const [connector, queue, problemQueue, countRows, issues, assistantRun] = await Promise.all([
    env.DB.prepare(`SELECT form_id, enabled, secret_prefix, last_event_at, last_processed_at, last_error, updated_at
      FROM fanke_connectors WHERE user_id = ?`).bind(userId).first<ConnectorRow>(),
    env.DB.prepare(`SELECT queue_id, form_id, submission_id, submitted_at, school_name, file_id, filename,
      download_url, size, kind, status, attempt_count, last_error, received_at, processed_at
      FROM fanke_files WHERE user_id = ? ORDER BY received_at DESC LIMIT 100`).bind(userId).all<QueueRow>(),
    env.DB.prepare(`SELECT queue_id, form_id, submission_id, submitted_at, school_name, file_id, filename,
      download_url, size, kind, status, attempt_count, last_error, received_at, processed_at
      FROM fanke_files WHERE user_id = ? AND status IN ('invalid','retry','ignored','processing')
      ORDER BY submitted_at DESC, received_at DESC`).bind(userId).all<QueueRow>(),
    env.DB.prepare(`SELECT kind, status, COUNT(*) AS total FROM fanke_files
      WHERE user_id = ? GROUP BY kind, status`).bind(userId).all<{ kind: string; status: string; total: number }>(),
    env.DB.prepare(`SELECT issue_id, form_id, submission_id, school_name, reason_code, message, received_at
      FROM fanke_issues WHERE user_id = ? ORDER BY received_at DESC LIMIT 50`).bind(userId).all<Record<string, unknown>>(),
    env.DB.prepare(`SELECT form_id, scan_id, target_kind, status, total_records, new_records, changed_records,
      unchanged_records, queued_files, unclassified_files, started_at, completed_at,
      last_error, updated_at FROM fanke_assistant_runs WHERE user_id = ?`)
      .bind(userId).first<Record<string, unknown>>(),
  ]);
  const counts: Record<string, number> = {};
  for (const row of countRows.results) counts[`${row.kind}:${row.status}`] = Number(row.total);
  const dashboardFile = (row: QueueRow) => ({
    queueId: row.queue_id,
    formId: row.form_id,
    submissionId: row.submission_id,
    submittedAt: row.submitted_at,
    schoolName: row.school_name,
    filename: row.filename,
    size: row.size,
    kind: row.kind,
    status: row.status,
    attemptCount: row.attempt_count,
    lastError: row.last_error,
    receivedAt: row.received_at,
    processedAt: row.processed_at,
  });
  return {
    connected: Boolean(connector?.enabled),
    connector: connector ? {
      formId: connector.form_id,
      enabled: connector.enabled === 1,
      secretPrefix: connector.secret_prefix,
      lastEventAt: connector.last_event_at,
      lastProcessedAt: connector.last_processed_at,
      lastError: connector.last_error,
      updatedAt: connector.updated_at,
    } : null,
    counts,
    recentFiles: queue.results.map(dashboardFile),
    problemFiles: problemQueue.results.map(dashboardFile),
    issues: issues.results.map((row) => ({
      id: row.issue_id,
      formId: row.form_id,
      submissionId: row.submission_id,
      schoolName: row.school_name,
      reasonCode: row.reason_code,
      message: row.message,
      receivedAt: row.received_at,
    })),
    assistant: assistantRun ? {
      formId: assistantRun.form_id,
      scanId: assistantRun.scan_id,
      targetKind: assistantRun.target_kind,
      status: assistantRun.status,
      totalRecords: assistantRun.total_records,
      newRecords: assistantRun.new_records,
      changedRecords: assistantRun.changed_records,
      unchangedRecords: assistantRun.unchanged_records,
      queuedFiles: assistantRun.queued_files,
      unclassifiedFiles: assistantRun.unclassified_files,
      startedAt: assistantRun.started_at,
      completedAt: assistantRun.completed_at,
      lastError: assistantRun.last_error,
      updatedAt: assistantRun.updated_at,
    } : null,
  };
}

async function processQueue(
  env: FankeCollectorEnv,
  userId: string,
  kind: FankeFileKind,
  processor: FankeFileProcessor,
): Promise<{ processed: number; ignored: number; invalid: number; retried: number; remaining: number; ready: number; processing: number; waitingRetry: number }> {
  await ensureFankeSchema(env.DB);
  const now = new Date();
  const staleAt = new Date(now.getTime() - STALE_PROCESSING_MS).toISOString();
  const rows = await env.DB.prepare(`SELECT queue_id, form_id, submission_id, submitted_at, school_name,
    file_id, filename, download_url, size, kind, status, attempt_count, last_error, received_at, processed_at
    FROM fanke_files
    WHERE user_id = ? AND kind = ?
      AND ((status IN ('pending','retry') AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
        OR (status = 'processing' AND last_attempt_at <= ?))
    -- Process oldest first on purpose. If one school submitted several versions,
    -- the greatest submitted_at is committed last; every storage layer also
    -- rejects an older submitted_at even when the source pages were scanned in
    -- descending order.
    ORDER BY submitted_at ASC, received_at ASC LIMIT ?`)
    // Each EDP opens an archive and reads every PDF. Sharing one request's CPU
    // and memory budget across 20 packages can kill it before its claim is
    // completed. The browser drains these one-file requests automatically.
    .bind(userId, kind, now.toISOString(), staleAt, kind === "edp" ? 1 : MAX_QUEUE_BATCH).all<QueueRow>();
  const summary = { processed: 0, ignored: 0, invalid: 0, retried: 0, remaining: 0, ready: 0, processing: 0, waitingRetry: 0 };
  for (const row of rows.results) {
    const claimToken = crypto.randomUUID();
    const claimed = await env.DB.prepare(`UPDATE fanke_files SET status = 'processing', claim_token = ?,
      attempt_count = attempt_count + 1, last_attempt_at = ?, updated_at = ?
      WHERE user_id = ? AND queue_id = ? AND (
        (status IN ('pending','retry') AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
        OR (status = 'processing' AND last_attempt_at <= ?)
      )`).bind(claimToken, now.toISOString(), now.toISOString(), userId, row.queue_id, now.toISOString(), staleAt).run();
    if ((claimed.meta.changes ?? 0) !== 1) continue;
    try {
      const outcome = await processor(queueFileFromRow({ ...row, attempt_count: row.attempt_count + 1 }));
      const completedAt = new Date().toISOString();
      const updated = await env.DB.prepare(`UPDATE fanke_files SET status = ?, processed_at = ?,
        last_error = ?, claim_token = NULL, next_attempt_at = NULL, updated_at = ?
        WHERE user_id = ? AND queue_id = ? AND claim_token = ?`)
        .bind(outcome.status, completedAt, outcome.status === "processed" ? null : outcome.message ?? null, completedAt, userId, row.queue_id, claimToken).run();
      if ((updated.meta.changes ?? 0) === 1) summary[outcome.status] += 1;
    } catch (error) {
      const attemptCount = row.attempt_count + 1;
      const permanent = attemptCount >= MAX_ATTEMPTS;
      const delayMinutes = Math.min(360, 2 ** Math.min(attemptCount, 8));
      const retryAt = new Date(Date.now() + delayMinutes * 60_000).toISOString();
      const message = error instanceof Error ? error.message.slice(0, 500) : "采集失败，请稍后重试。";
      await env.DB.prepare(`UPDATE fanke_files SET status = ?, last_error = ?, claim_token = NULL,
        next_attempt_at = ?, updated_at = ? WHERE user_id = ? AND queue_id = ? AND claim_token = ?`)
        .bind(permanent ? "invalid" : "retry", message, permanent ? null : retryAt, new Date().toISOString(), userId, row.queue_id, claimToken).run();
      if (permanent) summary.invalid += 1;
      else summary.retried += 1;
    }
  }
  await env.DB.prepare(`UPDATE fanke_connectors SET last_processed_at = ?, updated_at = ? WHERE user_id = ?`)
    .bind(new Date().toISOString(), new Date().toISOString(), userId).run();
  const checkedAt = new Date().toISOString();
  const checkedStaleAt = new Date(Date.now() - STALE_PROCESSING_MS).toISOString();
  // A live claim or a delayed retry is unfinished, not a completed scan.
  // Keep readiness separate so the client can wait without spinning or
  // stealing another request's claim. Expired claims remain claimable above.
  const remaining = await env.DB.prepare(`SELECT COUNT(*) AS total,
    COALESCE(SUM(CASE WHEN (status IN ('pending','retry') AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
      OR (status = 'processing' AND last_attempt_at <= ?) THEN 1 ELSE 0 END), 0) AS ready,
    COALESCE(SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END), 0) AS processing,
    COALESCE(SUM(CASE WHEN status = 'retry' THEN 1 ELSE 0 END), 0) AS waiting_retry
    FROM fanke_files WHERE user_id = ? AND kind = ? AND status IN ('pending','processing','retry')`)
    .bind(checkedAt, checkedStaleAt, userId, kind).first<{ total: number; ready: number; processing: number; waiting_retry: number }>();
  summary.remaining = Number(remaining?.total ?? 0);
  summary.ready = Number(remaining?.ready ?? 0);
  summary.processing = Number(remaining?.processing ?? 0);
  summary.waitingRetry = Number(remaining?.waiting_retry ?? 0);
  return summary;
}

export async function collectFankeNow(
  request: Request,
  env: FankeCollectorEnv,
  userId: string,
  kind: FankeFileKind,
  processor: FankeFileProcessor,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  const result = await processQueue(env, userId, kind, processor);
  return responseJson({ ok: true, kind, ...result });
}

export async function clearFankeProblems(
  request: Request,
  env: FankeCollectorEnv,
  userId: string,
  kind: FankeFileKind,
): Promise<Response> {
  if (request.method !== "DELETE") return methodNotAllowed(["DELETE"]);
  await ensureFankeSchema(env.DB);
  const result = await env.DB.prepare(`DELETE FROM fanke_files
    WHERE user_id = ? AND kind = ? AND status IN ('invalid','ignored')`)
    .bind(userId, kind).run();
  return responseJson({ ok: true, kind, deleted: Number(result.meta.changes ?? 0) });
}

export async function requeueFankeFilesForKind(db: D1Database, userId: string, kind: FankeFileKind): Promise<void> {
  await ensureFankeSchema(db);
  await db.prepare(`UPDATE fanke_files SET status = 'pending', next_attempt_at = NULL, last_error = NULL, updated_at = ?
    WHERE user_id = ? AND kind = ? AND status = 'ignored'`)
    .bind(new Date().toISOString(), userId, kind).run();
}

interface DueSettingRow { kind: FankeFileKind; interval_minutes: number }

export async function runDueFankeCollectors(
  env: FankeCollectorEnv,
  userId: string,
  processor: FankeFileProcessor,
): Promise<void> {
  await ensureFankeSchema(env.DB);
  const now = new Date().toISOString();
  const due = await env.DB.prepare(`
    SELECT 'registration' AS kind, interval_minutes FROM collector_settings
      WHERE user_id = ?1 AND enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?2
    UNION ALL SELECT 'edp', interval_minutes FROM edp_settings
      WHERE user_id = ?1 AND enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?2
    UNION ALL SELECT kind, interval_minutes FROM media_collector_settings
      WHERE user_id = ?1 AND enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?2
  `).bind(userId, now).all<DueSettingRow>();
  for (const setting of due.results) {
    await processQueue(env, userId, setting.kind, processor);
    const nextRunAt = new Date(Date.now() + setting.interval_minutes * 60_000).toISOString();
    if (setting.kind === "registration") {
      await env.DB.prepare(`UPDATE collector_settings SET next_run_at = ?, updated_at = ? WHERE user_id = ?`)
        .bind(nextRunAt, new Date().toISOString(), userId).run();
    } else if (setting.kind === "edp") {
      await env.DB.prepare(`UPDATE edp_settings SET next_run_at = ?, updated_at = ? WHERE user_id = ?`)
        .bind(nextRunAt, new Date().toISOString(), userId).run();
    } else {
      await env.DB.prepare(`UPDATE media_collector_settings SET next_run_at = ?, updated_at = ? WHERE user_id = ? AND kind = ?`)
        .bind(nextRunAt, new Date().toISOString(), userId, setting.kind).run();
    }
  }
}
