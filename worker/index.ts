/** Cloudflare Worker entry point for the registration collector. */
import JSZip from "jszip";
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import {
  abortMediaMultipartUpload,
  completeMediaMultipartUpload,
  createMediaMultipartUpload,
  deleteMediaAsset,
  downloadMediaAsset,
  isMediaAssetKind,
  listMediaAssets,
  uploadMediaMultipartPart,
  uploadMediaAsset,
} from "./media-assets";
import { manualFileMetadata, normalizeCompetitionSchoolName } from "./file-metadata";
import {
  assessRegistrationWorkbook,
  type RegistrationAssessment,
  RegistrationWorkbookError,
  updateMasterWorkbook,
} from "./registration-workbook";
import {
  classifyFankeFile,
  clearFankeProblems,
  collectFankeNow,
  configureFankeConnector,
  finishFankeAssistantScan,
  type FankeFileKind,
  type FankeProcessResult,
  type FankeQueueFile,
  getFankeDashboard,
  handleFankeWebhook,
  ingestFankeAssistantBatch,
  requeueFankeFilesForKind,
  runDueFankeCollectors,
  startFankeAssistantScan,
} from "./fanke-collector";
import {
  assignMailMediaCandidate,
  deleteMailAttachment,
  downloadMailAttachment,
  downloadRawMail,
  getMailDashboard,
  listMailMessagesPage,
  listMailMediaCandidates,
  runDueMailCollectors,
  syncMailNow,
  testMailSettings,
  updateMailSettings,
} from "./mail-api";
import {
  browserMailAssetsExist,
  finishBrowserMailScan,
  getBrowserMailScanState,
  ingestBrowserMailBatch,
  startBrowserMailScan,
} from "./browser-mail-media";
import {
  deleteEdpSubmissionAndReviews,
  handleEdpReviewApi,
  queueEdpReviewForSubmission,
  processNextEdpReview,
} from "./edp-review-api";
import { handleEdpRuleDocumentApi } from "./edp-rule-api";
import { handleCertificateTemplateApi } from "./certificate-template-api";
import { EdpArchiveError, type EdpArchiveFormat } from "./edp-archive-core";
import {
  inspectEdpPackage,
  type EdpPackageInspection,
  type EdpReasonCode,
  type EdpRegistrationCandidate,
  type EdpSubmissionRound,
} from "./edp-package";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  FILES: R2Bucket;
  APP_ACCESS_PASSWORD_HASH?: string;
  APP_FOUNDER_PASSWORD_HASH?: string;
  APP_SESSION_SECRET?: string;
  APP_CREDENTIAL_ENCRYPTION_KEY?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface SettingsRow {
  starts_at: string | null;
  run_time: string;
  timezone: string;
  interval_minutes: number;
  enabled: number;
  next_run_at: string | null;
}

interface MasterRow {
  r2_key: string;
  filename: string;
  size: number;
  uploaded_at: string;
}

interface RegistrationRow {
  school_key: string;
  school_name: string;
  r2_key: string;
  filename: string;
  submitted_at: string;
  submission_id: string;
  size: number;
  uploaded_at: string;
  receipt_status?: "qualified" | "unqualified" | null;
  receipt_email?: string | null;
  receipt_teacher_count?: number | null;
  receipt_student_count?: number | null;
  receipt_reasons_json?: string | null;
  receipt_assessed_at?: string | null;
}

interface RegistrationReceiptSettingsRow {
  competition_year: string;
  qq_group: string;
  updated_at: string;
}

interface RegistrationReceiptSettings {
  competitionYear: string;
  qqGroup: string;
  updatedAt: string | null;
}

interface EdpReceiptSettingsRow {
  competition_year: string;
  submission_round: number | null;
  updated_at: string;
}

interface EdpReceiptSettings {
  competitionYear: string;
  submissionRound: EdpSubmissionRound | null;
  updatedAt: string | null;
}

interface EdpSubmissionRow {
  school_key: string;
  school_name: string;
  r2_key: string;
  filename: string;
  content_type: string;
  submitted_at: string;
  submission_id: string;
  size: number;
  file_count: number;
  uploaded_at: string;
  submission_round: EdpSubmissionRound | null;
  submission_round_source: "captured" | "legacy_unknown" | "inferred_file_count" | "inferred_current_setting";
  archive_format: EdpArchiveFormat;
  embedded_registration_filename: string | null;
  embedded_registration_status: "none" | "synced" | "older" | "invalid";
  embedded_registration_message: string | null;
  has_review_job?: number;
}

interface EdpIssueRow {
  school_key: string;
  school_name: string;
  filename: string;
  submitted_at: string;
  submission_id: string;
  file_count: number;
  reason_code: EdpReasonCode;
  reason_codes_json: string;
  reasons_json: string;
  created_at: string;
}

interface EdpValidationResult {
  qualified: boolean;
  fileCount: number;
  reasonCode?: EdpReasonCode;
  reasonCodes: EdpReasonCode[];
  reasons: string[];
}

interface CollectorSettings {
  startsAt: string | null;
  runTime: string;
  timezone: string;
  intervalMinutes: number;
  enabled: boolean;
  nextRunAt: string | null;
}

interface AuthConfig {
  configured: boolean;
  passwordHash?: PasswordHash;
  sessionSecret?: string;
  passwordVersion: number;
}

interface AppSecuritySettingsRow {
  shared_password_hash: string;
  password_version: number;
  updated_at: string;
}

interface PasswordHash {
  iterations: number;
  salt: Uint8Array;
  hash: Uint8Array;
}

interface SessionPayload {
  v: 1;
  pv: number;
  iat: number;
  exp: number;
  nonce: string;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const ZIP_CONTENT_TYPE = "application/zip";
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const SHARED_USER_ID = "shared-browser-workspace";
const PASSWORD_HASH_ITERATIONS = 100_000;
const LOCAL_PASSWORD_HASH = "pbkdf2-sha256$100000$Y2hlbWVjYXItbG9jYWwtcHJldmlldy12MQ$DApe3GWm-9Syot9hQ_wbo1xhTa1w4HYIBIXXn3KSTQc";
const LOCAL_FOUNDER_PASSWORD_HASH = "pbkdf2-sha256$100000$YZMHqHwfVj1rCDz9lzx0pHEf$2bi9ca8o9eJkSRb9OOMeo-w300uKQkw7jtyp9lZn3Zg";
const LOCAL_SESSION_SECRET = "chemecar-local-preview-session-secret-v1-only";
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const MAX_LOGIN_BODY_BYTES = 8 * 1024;
const MAX_FOUNDER_BODY_BYTES = 16 * 1024;
const NEW_PASSWORD_MIN_LENGTH = 12;
const NEW_PASSWORD_MAX_LENGTH = 128;
const PRODUCTION_SESSION_COOKIE = "__Host-chemecar_session";
const LOCAL_SESSION_COOKIE = "chemecar_session";
const DEFAULT_SETTINGS: CollectorSettings = {
  startsAt: null,
  runTime: "09:00",
  timezone: "Asia/Shanghai",
  intervalMinutes: 1440,
  enabled: false,
  nextRunAt: null,
};

const schemaPromises = new WeakMap<object, Promise<void>>();

function json(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(data), { status, headers });
}

function authJson(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Vary", "Cookie");
  return json(data, status, headers);
}

function apiError(status: number, code: string, message: string): Response {
  return json({ ok: false, error: { code, message } }, status);
}

function methodNotAllowed(allowed: string[]): Response {
  return json(
    { ok: false, error: { code: "method_not_allowed", message: `此接口仅支持 ${allowed.join("、")} 请求。` } },
    405,
    { Allow: allowed.join(", ") },
  );
}

function authMethodNotAllowed(allowed: string[]): Response {
  return authJson(
    { ok: false, authenticated: false, error: { code: "method_not_allowed", message: `此接口仅支持 ${allowed.join("、")} 请求。` } },
    405,
    { Allow: allowed.join(", ") },
  );
}

function isLocalhost(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string, maxBytes = 4096): Uint8Array | null {
  if (!value || value.length > Math.ceil(maxBytes * 4 / 3) + 4 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
    const binary = atob(padded);
    if (binary.length > maxBytes) return null;
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

function parsePasswordHash(value: string | undefined): PasswordHash | null {
  if (!value || value.length > 512) return null;
  const match = value.match(/^pbkdf2-sha256\$(\d{6,7})\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/);
  if (!match) return null;
  const iterations = Number(match[1]);
  const salt = decodeBase64Url(match[2], 64);
  const hash = decodeBase64Url(match[3], 64);
  if (iterations !== PASSWORD_HASH_ITERATIONS || !salt || salt.length < 16 || !hash || hash.length !== 32) {
    return null;
  }
  return { iterations, salt, hash };
}

function getSessionSecret(env: Env, url: URL): string | undefined {
  const sessionSecret = isLocalhost(url)
    ? (env.APP_SESSION_SECRET && env.APP_SESSION_SECRET.length >= 32 ? env.APP_SESSION_SECRET : LOCAL_SESSION_SECRET)
    : env.APP_SESSION_SECRET;
  return sessionSecret && sessionSecret.length >= 32 ? sessionSecret : undefined;
}

async function getAuthConfig(env: Env, url: URL): Promise<AuthConfig> {
  const sessionSecret = getSessionSecret(env, url);
  if (!sessionSecret) return { configured: false, passwordVersion: 1 };
  await ensureSchema(env.DB);

  const override = await env.DB.prepare(`
    SELECT shared_password_hash, password_version, updated_at
    FROM app_security_settings
    WHERE singleton_id = 1
  `).first<AppSecuritySettingsRow>();
  if (override) {
    const passwordHash = parsePasswordHash(override.shared_password_hash);
    const passwordVersion = override.password_version;
    if (!passwordHash || !Number.isSafeInteger(passwordVersion) || passwordVersion < 1) {
      return { configured: false, sessionSecret, passwordVersion: 1 };
    }
    return { configured: true, passwordHash, sessionSecret, passwordVersion };
  }

  const passwordHash = env.APP_ACCESS_PASSWORD_HASH !== undefined
    ? parsePasswordHash(env.APP_ACCESS_PASSWORD_HASH)
    : isLocalhost(url) ? parsePasswordHash(LOCAL_PASSWORD_HASH)! : null;
  if (!passwordHash) return { configured: false, sessionSecret, passwordVersion: 1 };
  return { configured: true, passwordHash, sessionSecret, passwordVersion: 1 };
}

function getFounderPasswordHash(env: Env, url: URL): PasswordHash | null {
  if (env.APP_FOUNDER_PASSWORD_HASH !== undefined) return parsePasswordHash(env.APP_FOUNDER_PASSWORD_HASH);
  return isLocalhost(url) ? parsePasswordHash(LOCAL_FOUNDER_PASSWORD_HASH) : null;
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

async function derivePasswordHash(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array | null> {
  if (iterations !== PASSWORD_HASH_ITERATIONS || salt.length < 16 || salt.length > 64) return null;
  try {
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    return new Uint8Array(await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(salt), iterations },
      keyMaterial,
      256,
    ));
  } catch {
    // Authentication must fail closed when the runtime rejects PBKDF2 parameters.
    return null;
  }
}

async function passwordMatches(candidate: string, passwordHash: PasswordHash): Promise<boolean> {
  if (passwordHash.hash.length !== 32) return false;
  const derived = await derivePasswordHash(candidate, passwordHash.salt, passwordHash.iterations);
  return derived ? constantTimeEqual(derived, passwordHash.hash) : false;
}

async function createPasswordHash(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(18));
  const derived = await derivePasswordHash(password, salt, PASSWORD_HASH_ITERATIONS);
  if (!derived) {
    throw new ApiError(503, "password_hashing_unavailable", "服务器暂时无法安全生成密码，请稍后重试。");
  }
  return `pbkdf2-sha256$${PASSWORD_HASH_ITERATIONS}$${encodeBase64Url(salt)}$${encodeBase64Url(derived)}`;
}

function cookieName(url: URL): string {
  return isLocalhost(url) ? LOCAL_SESSION_COOKIE : PRODUCTION_SESSION_COOKIE;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}

function sessionCookie(url: URL, token: string, maxAge: number): string {
  const attributes = [
    `${cookieName(url)}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
  ];
  if (!isLocalhost(url)) attributes.push("Secure");
  if (maxAge === 0) attributes.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  return attributes.join("; ");
}

async function createSessionToken(
  secret: string,
  passwordVersion: number,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<{ token: string; expiresAt: string }> {
  const nonceBytes = crypto.getRandomValues(new Uint8Array(18));
  const payload: SessionPayload = {
    v: 1,
    pv: passwordVersion,
    iat: nowSeconds,
    exp: nowSeconds + SESSION_TTL_SECONDS,
    nonce: encodeBase64Url(nonceBytes),
  };
  const encodedPayload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = encodeBase64Url(await hmacSha256(secret, `chemecar-session-v1.${encodedPayload}`));
  return { token: `${encodedPayload}.${signature}`, expiresAt: new Date(payload.exp * 1000).toISOString() };
}

async function verifySessionToken(token: string | null, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<SessionPayload | null> {
  if (!token || token.length > 8192) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const payloadBytes = decodeBase64Url(parts[0], 1024);
  const suppliedSignature = decodeBase64Url(parts[1], 64);
  if (!payloadBytes || !suppliedSignature) return null;
  const expectedSignature = await hmacSha256(secret, `chemecar-session-v1.${parts[0]}`);
  if (!constantTimeEqual(suppliedSignature, expectedSignature)) return null;

  try {
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as Partial<SessionPayload>;
    const passwordVersion = payload.pv === undefined ? 1 : payload.pv;
    if (
      payload.v !== 1 || !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) ||
      !Number.isSafeInteger(passwordVersion) || (passwordVersion as number) < 1 ||
      typeof payload.nonce !== "string" || !/^[A-Za-z0-9_-]{20,32}$/.test(payload.nonce) ||
      (payload.iat as number) > nowSeconds + 300 || (payload.exp as number) <= nowSeconds ||
      (payload.exp as number) <= (payload.iat as number) || (payload.exp as number) - (payload.iat as number) > SESSION_TTL_SECONDS
    ) return null;
    return { ...(payload as SessionPayload), pv: passwordVersion as number };
  } catch {
    return null;
  }
}

function requireSameOrigin(request: Request, url: URL): void {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method.toUpperCase())) return;
  const origin = request.headers.get("Origin");
  if (!origin) throw new ApiError(403, "origin_required", "写入请求缺少来源信息。");
  try {
    if (new URL(origin).origin !== url.origin) {
      throw new ApiError(403, "cross_origin_forbidden", "不允许从其他网站修改采集数据。");
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(403, "invalid_origin", "写入请求的来源无效。");
  }
}

async function ensureSchema(db: D1Database): Promise<void> {
  const cacheKey = db as unknown as object;
  const existing = schemaPromises.get(cacheKey);
  if (existing) return existing;

  const pending = (async () => {
    await db.batch([
      db.prepare(`
        CREATE TABLE IF NOT EXISTS collector_settings (
          user_id TEXT PRIMARY KEY NOT NULL,
          starts_at TEXT,
          run_time TEXT NOT NULL DEFAULT '09:00',
          timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
          interval_minutes INTEGER NOT NULL DEFAULT 1440,
          enabled INTEGER NOT NULL DEFAULT 0,
          next_run_at TEXT,
          updated_at TEXT NOT NULL
        )
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS collector_master_files (
          user_id TEXT PRIMARY KEY NOT NULL,
          r2_key TEXT NOT NULL,
          filename TEXT NOT NULL,
          content_type TEXT NOT NULL,
          size INTEGER NOT NULL,
          uploaded_at TEXT NOT NULL
        )
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS collector_registrations (
          user_id TEXT NOT NULL,
          school_key TEXT NOT NULL,
          school_name TEXT NOT NULL,
          r2_key TEXT NOT NULL,
          filename TEXT NOT NULL,
          content_type TEXT NOT NULL,
          submitted_at TEXT NOT NULL,
          submission_id TEXT NOT NULL,
          size INTEGER NOT NULL,
          uploaded_at TEXT NOT NULL,
          PRIMARY KEY (user_id, school_key)
        )
      `),
      db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_collector_registrations_user_school_name
        ON collector_registrations (user_id, school_name COLLATE NOCASE)
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS registration_receipt_settings (
          user_id TEXT PRIMARY KEY NOT NULL,
          competition_year TEXT NOT NULL DEFAULT '',
          qq_group TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL
        )
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS registration_receipts (
          user_id TEXT NOT NULL,
          school_key TEXT NOT NULL,
          school_name TEXT NOT NULL,
          submission_id TEXT NOT NULL,
          recipient_email TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL CHECK (status IN ('qualified','unqualified')),
          teacher_count INTEGER NOT NULL DEFAULT 0,
          student_count INTEGER NOT NULL DEFAULT 0,
          reasons_json TEXT NOT NULL DEFAULT '[]',
          assessed_at TEXT NOT NULL,
          PRIMARY KEY (user_id, school_key)
        )
      `),
      db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_registration_receipts_user_status
        ON registration_receipts (user_id, status)
      `),
      db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_collector_settings_enabled_next_run
        ON collector_settings (enabled, next_run_at)
        WHERE enabled = 1
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS edp_settings (
          user_id TEXT PRIMARY KEY NOT NULL,
          starts_at TEXT,
          run_time TEXT NOT NULL DEFAULT '09:00',
          timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
          interval_minutes INTEGER NOT NULL DEFAULT 1440,
          enabled INTEGER NOT NULL DEFAULT 0,
          next_run_at TEXT,
          updated_at TEXT NOT NULL
        )
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS edp_receipt_settings (
          user_id TEXT PRIMARY KEY NOT NULL,
          competition_year TEXT NOT NULL DEFAULT '',
          submission_round INTEGER,
          updated_at TEXT NOT NULL,
          CONSTRAINT chk_edp_receipt_settings_round CHECK (submission_round IS NULL OR submission_round IN (1, 2, 3, 4, 5))
        )
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS edp_submissions (
          user_id TEXT NOT NULL,
          school_key TEXT NOT NULL,
          school_name TEXT NOT NULL,
          r2_key TEXT NOT NULL,
          filename TEXT NOT NULL,
          content_type TEXT NOT NULL,
          submitted_at TEXT NOT NULL,
          submission_id TEXT NOT NULL,
          size INTEGER NOT NULL,
          file_count INTEGER NOT NULL,
          uploaded_at TEXT NOT NULL,
          submission_round INTEGER CHECK (submission_round IS NULL OR submission_round BETWEEN 1 AND 5),
          submission_round_source TEXT NOT NULL DEFAULT 'legacy_unknown',
          archive_format TEXT NOT NULL DEFAULT 'zip' CHECK (archive_format IN ('zip', '7z', 'rar')),
          embedded_registration_filename TEXT,
          embedded_registration_status TEXT NOT NULL DEFAULT 'none' CHECK (embedded_registration_status IN ('none', 'synced', 'older', 'invalid')),
          embedded_registration_message TEXT,
          PRIMARY KEY (user_id, school_key)
        )
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS edp_issues (
          user_id TEXT NOT NULL,
          school_key TEXT NOT NULL,
          school_name TEXT NOT NULL,
          filename TEXT NOT NULL,
          submitted_at TEXT NOT NULL,
          submission_id TEXT NOT NULL,
          file_count INTEGER NOT NULL,
          reason_code TEXT NOT NULL,
          reason_codes_json TEXT NOT NULL,
          reasons_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (user_id, school_key)
        )
      `),
      db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_edp_settings_enabled_next_run
        ON edp_settings (enabled, next_run_at)
        WHERE enabled = 1
      `),
      db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_edp_submissions_user_school_name
        ON edp_submissions (user_id, school_name COLLATE NOCASE)
      `),
      db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_edp_issues_user_created_at
        ON edp_issues (user_id, created_at)
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS auth_login_attempts (
          client_hash TEXT PRIMARY KEY NOT NULL,
          window_started_at INTEGER NOT NULL,
          failure_count INTEGER NOT NULL DEFAULT 0,
          locked_until INTEGER,
          updated_at INTEGER NOT NULL
        )
      `),
      db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_auth_login_attempts_locked_until
        ON auth_login_attempts (locked_until)
      `),
      db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_auth_login_attempts_updated_at
        ON auth_login_attempts (updated_at)
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS app_security_settings (
          singleton_id INTEGER PRIMARY KEY NOT NULL DEFAULT 1,
          shared_password_hash TEXT NOT NULL,
          password_version INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT NOT NULL,
          CONSTRAINT chk_app_security_settings_singleton CHECK (singleton_id = 1),
          CONSTRAINT chk_app_security_settings_password_version CHECK (password_version >= 1)
        )
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS media_collector_settings (
          user_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('poster', 'video')),
          starts_at TEXT,
          run_time TEXT NOT NULL DEFAULT '09:00',
          timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
          interval_minutes INTEGER NOT NULL DEFAULT 1440,
          enabled INTEGER NOT NULL DEFAULT 0,
          next_run_at TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (user_id, kind)
        )
      `),
      db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_media_collector_settings_enabled_next_run
        ON media_collector_settings (enabled, next_run_at)
        WHERE enabled = 1
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS edp_review_settings (
          user_id TEXT PRIMARY KEY NOT NULL,
          competition_year TEXT NOT NULL DEFAULT '',
          safety_reviewer_name TEXT NOT NULL DEFAULT '',
          safety_reviewer_email TEXT NOT NULL DEFAULT '',
          expert_member_name TEXT NOT NULL DEFAULT '',
          expert_member_email TEXT NOT NULL DEFAULT '',
          template_version TEXT NOT NULL DEFAULT 'v1',
          active_rule_document_id TEXT,
          active_rule_version TEXT,
          updated_at TEXT NOT NULL
        )
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS edp_rule_documents (
          user_id TEXT NOT NULL,
          document_id TEXT NOT NULL,
          applicable_year INTEGER NOT NULL,
          entered_year INTEGER NOT NULL,
          detected_year INTEGER,
          filename TEXT NOT NULL,
          r2_key TEXT NOT NULL,
          sha256 TEXT NOT NULL,
          size INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','needs_confirmation','active','archived','failed')),
          parse_warnings_json TEXT NOT NULL DEFAULT '[]',
          parse_error TEXT,
          builtin_rule_version TEXT NOT NULL,
          rule_version TEXT NOT NULL,
          year_conflict_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (year_conflict_confirmed IN (0,1)),
          confirmed_at TEXT,
          activated_at TEXT,
          archived_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (user_id, document_id),
          CONSTRAINT chk_edp_rule_documents_year CHECK (applicable_year BETWEEN 2000 AND 2200 AND entered_year BETWEEN 2000 AND 2200 AND (detected_year IS NULL OR detected_year BETWEEN 2000 AND 2200)),
          CONSTRAINT chk_edp_rule_documents_size CHECK (size > 0 AND size <= 52428800),
          CONSTRAINT chk_edp_rule_documents_sha256 CHECK (length(sha256) = 64)
        )
      `),
      db.prepare(`
        CREATE UNIQUE INDEX IF NOT EXISTS uidx_edp_rule_documents_year_sha
        ON edp_rule_documents (user_id, applicable_year, sha256)
      `),
      db.prepare(`
        CREATE UNIQUE INDEX IF NOT EXISTS uidx_edp_rule_documents_active_year
        ON edp_rule_documents (user_id, applicable_year) WHERE status = 'active'
      `),
      db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_edp_rule_documents_year_status_created
        ON edp_rule_documents (user_id, applicable_year, status, created_at)
      `),
      db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_edp_rule_documents_rule_version
        ON edp_rule_documents (user_id, rule_version)
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS edp_rule_facts (
          user_id TEXT NOT NULL,
          document_id TEXT NOT NULL,
          fact_id TEXT NOT NULL,
          category TEXT NOT NULL CHECK (category IN ('numeric_limit','required','prohibited','allowed','conditional')),
          section TEXT NOT NULL DEFAULT '',
          normalized_requirement TEXT NOT NULL,
          operator TEXT NOT NULL CHECK (operator IN ('lt','lte','eq','gte','gt','must','must_not','may','conditional')),
          structured_value TEXT,
          structured_unit TEXT,
          condition_text TEXT,
          source_page INTEGER NOT NULL CHECK (source_page >= 1),
          evidence_excerpt TEXT NOT NULL,
          confidence TEXT NOT NULL CHECK (confidence IN ('high','medium','low')),
          confirmation_status TEXT NOT NULL DEFAULT 'pending' CHECK (confirmation_status IN ('pending','confirmed','rejected')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (user_id, document_id, fact_id)
        )
      `),
      db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_edp_rule_facts_document_page
        ON edp_rule_facts (user_id, document_id, source_page, fact_id)
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS edp_review_jobs (
          user_id TEXT NOT NULL,
          job_id TEXT NOT NULL,
          school_key TEXT NOT NULL,
          school_name TEXT NOT NULL,
          submission_id TEXT NOT NULL,
          submitted_at TEXT NOT NULL,
          submission_round INTEGER NOT NULL CHECK (submission_round BETWEEN 1 AND 5),
          source_r2_key TEXT,
          source_filename TEXT,
          work_name TEXT,
          instructor_name TEXT,
          instructor_email TEXT,
          rule_version TEXT NOT NULL,
          template_version TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','needs_human','ready','completed','failed','superseded')),
          overall_status TEXT NOT NULL DEFAULT 'pending' CHECK (overall_status IN ('pending','passed','failed','needs_human')),
          superseded_by TEXT,
          last_error TEXT,
          reviewed_at TEXT,
          finalized_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (user_id, job_id)
        )
      `),
      db.prepare(`
        CREATE UNIQUE INDEX IF NOT EXISTS uidx_edp_review_jobs_submission_rule
        ON edp_review_jobs (user_id, school_key, submission_id, rule_version)
      `),
      db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_edp_review_jobs_school_updated
        ON edp_review_jobs (user_id, school_key, updated_at)
      `),
      db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_edp_review_jobs_status_updated
        ON edp_review_jobs (user_id, status, updated_at)
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS edp_review_items (
          user_id TEXT NOT NULL,
          job_id TEXT NOT NULL,
          rule_id TEXT NOT NULL,
          worksheet_name TEXT NOT NULL DEFAULT '2) EDP Evaluation',
          template_row INTEGER NOT NULL CHECK (template_row BETWEEN 1 AND 1048576),
          automatic_status TEXT NOT NULL CHECK (automatic_status IN ('yes','no','not_applicable','needs_human')),
          final_status TEXT NOT NULL CHECK (final_status IN ('yes','no','not_applicable','needs_human')),
          suggested_comment TEXT,
          final_comment TEXT,
          evidence_json TEXT NOT NULL DEFAULT '[]',
          document_name TEXT,
          page_number INTEGER CHECK (page_number IS NULL OR page_number >= 1),
          is_blocking INTEGER NOT NULL DEFAULT 1 CHECK (is_blocking IN (0,1)),
          rule_source TEXT NOT NULL DEFAULT 'builtin:v1',
          override_actor TEXT,
          override_previous_status TEXT CHECK (override_previous_status IS NULL OR override_previous_status IN ('yes','no','not_applicable','needs_human')),
          overridden_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (user_id, job_id, rule_id)
        )
      `),
      db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_edp_review_items_job_status
        ON edp_review_items (user_id, job_id, final_status, template_row)
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS edp_review_exports (
          user_id TEXT NOT NULL,
          job_id TEXT NOT NULL,
          export_type TEXT NOT NULL CHECK (export_type IN ('draft','final')),
          r2_key TEXT NOT NULL,
          filename TEXT NOT NULL,
          size INTEGER NOT NULL CHECK (size > 0),
          rule_version TEXT NOT NULL,
          template_version TEXT NOT NULL,
          submission_id TEXT NOT NULL,
          generated_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (user_id, job_id, export_type)
        )
      `),
      db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_edp_review_exports_generated
        ON edp_review_exports (user_id, generated_at)
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS certificate_templates (
          user_id TEXT PRIMARY KEY NOT NULL,
          event_name TEXT NOT NULL DEFAULT '',
          issuer_text TEXT NOT NULL DEFAULT '',
          stamp_r2_key TEXT,
          stamp_filename TEXT,
          stamp_content_type TEXT,
          stamp_size INTEGER,
          updated_at TEXT NOT NULL,
          CONSTRAINT chk_certificate_templates_stamp_size
            CHECK (stamp_size IS NULL OR (stamp_size > 0 AND stamp_size <= 5242880))
        )
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

function settingsFromRow(row: SettingsRow | null): CollectorSettings {
  if (!row) return { ...DEFAULT_SETTINGS };
  return {
    startsAt: row.starts_at,
    runTime: row.run_time,
    timezone: "Asia/Shanghai",
    intervalMinutes: row.interval_minutes,
    enabled: row.enabled === 1,
    nextRunAt: row.next_run_at,
  };
}

function masterFromRow(row: MasterRow | null) {
  if (!row) return null;
  return {
    filename: row.filename,
    size: row.size,
    uploadedAt: row.uploaded_at,
    downloadUrl: "/api/master/download",
  };
}

const DEFAULT_RECEIPT_SETTINGS: RegistrationReceiptSettings = {
  competitionYear: "",
  qqGroup: "",
  updatedAt: null,
};

function receiptSettingsFromRow(row: RegistrationReceiptSettingsRow | null): RegistrationReceiptSettings {
  if (!row) return { ...DEFAULT_RECEIPT_SETTINGS };
  return {
    competitionYear: row.competition_year,
    qqGroup: row.qq_group,
    updatedAt: row.updated_at,
  };
}

async function getRegistrationReceiptSettings(db: D1Database, userId: string): Promise<RegistrationReceiptSettings> {
  const row = await db.prepare(`SELECT competition_year, qq_group, updated_at
    FROM registration_receipt_settings WHERE user_id = ?`)
    .bind(userId).first<RegistrationReceiptSettingsRow>();
  return receiptSettingsFromRow(row);
}

const DEFAULT_EDP_RECEIPT_SETTINGS: EdpReceiptSettings = {
  competitionYear: "",
  submissionRound: null,
  updatedAt: null,
};

function isEdpSubmissionRound(value: number | null): value is EdpSubmissionRound {
  return value !== null && Number.isInteger(value) && value >= 1 && value <= 5;
}

function edpReceiptSettingsFromRow(row: EdpReceiptSettingsRow | null): EdpReceiptSettings {
  if (!row) return { ...DEFAULT_EDP_RECEIPT_SETTINGS };
  return {
    competitionYear: row.competition_year,
    submissionRound: isEdpSubmissionRound(row.submission_round) ? row.submission_round : null,
    updatedAt: row.updated_at,
  };
}

async function getEdpReceiptSettings(db: D1Database, userId: string): Promise<EdpReceiptSettings> {
  const row = await db.prepare(`SELECT competition_year, submission_round, updated_at
    FROM edp_receipt_settings WHERE user_id = ?`)
    .bind(userId).first<EdpReceiptSettingsRow>();
  return edpReceiptSettingsFromRow(row);
}

function edpReceiptSettingsComplete(settings: EdpReceiptSettings): settings is EdpReceiptSettings & { submissionRound: EdpSubmissionRound } {
  return /^20\d{2}$/u.test(settings.competitionYear)
    && isEdpSubmissionRound(settings.submissionRound);
}

function edpExpectedFileCount(settings: EdpReceiptSettings): number | null {
  if (!edpReceiptSettingsComplete(settings)) return null;
  return settings.submissionRound === 1 ? 3 : 4;
}

function edpExpectedContents(round: EdpSubmissionRound): string {
  return round === 1
    ? "中文版 EDP、英文版 EDP、EDP 增补文件，共 3 个 PDF 文件"
    : "中文版 EDP、英文版 EDP、EDP 增补文件和 MOC，共 4 个 PDF 文件";
}

function registrationReceiptSettingsComplete(settings: RegistrationReceiptSettings): boolean {
  return /^20\d{2}$/u.test(settings.competitionYear) && /^\d{5,20}$/u.test(settings.qqGroup);
}

function naturalList(values: string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  return `${values.slice(0, -1).join("、")}和${values.at(-1)}`;
}

function humanizeRegistrationReasons(reasons: string[]): string[] {
  const groupedRows = new Map<string, { table: string; row: string; fields: string[] }>();
  const output: string[] = [];
  for (const reason of reasons) {
    const rowIssue = reason.match(/^(表[12])-(指导教师|团队成员)第(\d+)行缺少(.+?)。$/u);
    if (rowIssue) {
      const [, table, roster, row, rawField] = rowIssue;
      const field = rawField
        .replace(/^(?:指导教师|团队成员)/u, "")
        .replace(/^E-mail$/iu, "邮箱");
      const key = `${table}:${roster}:${row}`;
      const current = groupedRows.get(key) ?? { table: `${table}${roster}`, row, fields: [] };
      if (!current.fields.includes(field)) current.fields.push(field);
      groupedRows.set(key, current);
      continue;
    }
    output.push(reason
      .replaceAll("表1-指导教师", "表1指导教师")
      .replaceAll("表2-团队成员", "表2团队成员")
      .replaceAll("E-mail", "邮箱"));
  }
  for (const issue of groupedRows.values()) {
    output.push(`${issue.table}第${issue.row}行未填写${naturalList(issue.fields)}。`);
  }
  return Array.from(new Set(output));
}

function registrationReceiptSubject(schoolName: string, status: "qualified" | "unqualified" | "needs_review"): string {
  if (status === "qualified") return `中国大学生Chem-E-Car®竞赛报名成功回执｜${schoolName}参赛队`;
  if (status === "unqualified") return `中国大学生Chem-E-Car®竞赛报名表修改通知｜${schoolName}参赛队`;
  return `中国大学生Chem-E-Car®竞赛报名回执｜${schoolName}参赛队`;
}

function registrationReceiptBody(
  schoolName: string,
  status: "qualified" | "unqualified",
  settings: RegistrationReceiptSettings,
  reasons: string[],
): string {
  const signature = `祝好 Best Regards
中国大学生Chem-E-Car®竞赛委员会
Chinese Regional Chem-E-Car® Competition Committee
地址：天津市津南区雅观路135号50教学楼B338室 邮编：300350
Address: Rm. B338, Building 50, 135 Yaguan Road, Tianjin 300350, China
Email: service@chemecar.cn`;
  if (status === "unqualified") {
    const issueLines = (reasons.length ? reasons : ["报名表中仍有必填信息无法确认，请重新核对并提交完整文件。"])
      .map((reason, index) => `${index + 1}. ${reason}`)
      .join("\n");
    return `${schoolName}参赛队：

你好！

我们已经收到你校竞赛报名表，但本次报名暂未通过检查。经核对，发现以下问题：
${issueLines}

请根据以上具体问题修改报名表，并重新提交完整的最新版文件。组委会将在收到后再次核对。

${signature}`;
  }
  if (!registrationReceiptSettingsComplete(settings)) return "";
  const competitionYear = settings.competitionYear;
  const qqGroup = settings.qqGroup;
  return `${schoolName}参赛队：

你好！

欢迎你校的报名与参与，中国大学生Chem-E-Car®竞赛组委会已经收到你校竞赛报名表，你校已成功报名${competitionYear}年Chem-E-Car®竞赛。

请各参赛队负责人搜索群号${qqGroup}加入${competitionYear}年中国大学生Chem-E-Car®竞赛交流QQ群，进群后请修改群昵称为：学校名-姓名；

参赛详情请参见官网www.chemecar.cn。如有问题可以直接在竞赛交流群内提问，也可通过竞赛网站讨论区进行留言或发送邮件至service@chemecar.cn进行询问。

${signature}`;
}

function registrationFromRow(
  row: RegistrationRow,
  receiptSettings: RegistrationReceiptSettings = DEFAULT_RECEIPT_SETTINGS,
) {
  const storedReasons = parsedStringArray(row.receipt_reasons_json ?? "[]");
  // Receipts produced before the effective-row fix may contain false issues
  // from Excel's final row (1,048,576).  Do not display or send those old
  // results: require one clean re-read of the stored workbook instead.
  const requiresReassessment = storedReasons.some((reason) => /第1048576行/u.test(reason));
  const receiptStatus = requiresReassessment ? "needs_review" : row.receipt_status ?? "needs_review";
  const receiptReasons = requiresReassessment ? [] : humanizeRegistrationReasons(storedReasons);
  return {
    schoolKey: row.school_key,
    schoolName: row.school_name,
    filename: row.filename,
    submittedAt: row.submitted_at,
    submissionId: row.submission_id,
    size: row.size,
    uploadedAt: row.uploaded_at,
    downloadUrl: `/api/registrations/${encodeURIComponent(row.school_key)}/download`,
    receipt: {
      status: receiptStatus,
      recipientEmail: row.receipt_email ?? "",
      subject: registrationReceiptSubject(row.school_name, receiptStatus),
      body: receiptStatus === "needs_review"
        ? ""
        : registrationReceiptBody(row.school_name, receiptStatus, receiptSettings, receiptReasons),
      settingsComplete: registrationReceiptSettingsComplete(receiptSettings),
      requiresReassessment,
      teacherCount: row.receipt_teacher_count ?? 0,
      studentCount: row.receipt_student_count ?? 0,
      reasons: receiptReasons,
      assessedAt: row.receipt_assessed_at ?? null,
    },
  };
}

function edpReceiptSubject(schoolName: string, status: "qualified" | "unqualified" | "needs_configuration"): string {
  if (status === "qualified") return `中国大学生Chem-E-Car®竞赛EDP提交成功回执｜${schoolName}参赛队`;
  if (status === "unqualified") return `中国大学生Chem-E-Car®竞赛EDP修改通知｜${schoolName}参赛队`;
  return `中国大学生Chem-E-Car®竞赛EDP提交回执｜${schoolName}参赛队`;
}

function edpReceiptReasons(
  fileCount: number,
  reasonCodes: EdpReasonCode[],
  rawReasons: string[],
  settings: EdpReceiptSettings,
): string[] {
  const reasons = rawReasons.filter((reason) => !edpReceiptSettingsComplete(settings)
    || !/业务文件应为 3 个必需 PDF，或加 1 个 MOC PDF|^第[1-5]次提交应包含 \d+ 个 PDF 文件/u.test(reason));
  const expectedCount = edpExpectedFileCount(settings);
  if (expectedCount !== null && fileCount !== expectedCount) {
    const required = edpExpectedContents(settings.submissionRound as EdpSubmissionRound);
    reasons.unshift(`第${settings.submissionRound}次提交应包含${required}；当前识别到 ${fileCount} 个业务文件。`);
  }
  if (reasonCodes.includes("file_format") && !reasons.some((reason) => /PDF|ZIP|压缩|文件头|解压/u.test(reason))) {
    reasons.push("压缩包内存在格式不符合要求或无法正常读取的文件。");
  }
  if (reasonCodes.includes("classification") && !reasons.some((reason) => /中文版|英文版|增补|补充|MOC|判断/u.test(reason))) {
    reasons.push("无法完整识别中文版 EDP、英文版 EDP、EDP 增补文件或 MOC。");
  }
  return Array.from(new Set(reasons));
}

function edpReceiptBody(
  schoolName: string,
  status: "qualified" | "unqualified",
  settings: EdpReceiptSettings & { submissionRound: EdpSubmissionRound },
  reasons: string[],
  reasonCodes: EdpReasonCode[],
): string {
  const signature = `祝好 Best Regards
中国大学生Chem-E-Car®竞赛委员会
Chinese Regional Chem-E-Car® Competition Committee
地址：天津市津南区雅观路135号50教学楼B338室 邮编：300350
Address: Rm. B338, Building 50, 135 Yaguan Road, Tianjin 300350, China
Email: service@chemecar.cn`;
  if (status === "qualified") {
    return `${schoolName}参赛队：

你好！

中国大学生Chem-E-Car®竞赛组委会已经收到你校EDP，你校已成功提交${settings.competitionYear}年Chem-E-Car®竞赛EDP【第${settings.submissionRound}次】。

${signature}`;
  }

  const issueLines = (reasons.length ? reasons : ["压缩包未通过文件数量、PDF 格式或文件类别检查。"])
    .map((reason, index) => `${index + 1}. ${reason}`)
    .join("\n");
  const guidance: string[] = [
    `本次为第${settings.submissionRound}次提交，请在一个 ZIP、7z 或 RAR 压缩包内放入${edpExpectedContents(settings.submissionRound)}。`,
  ];
  if (reasonCodes.includes("file_format")) {
    guidance.push("请确保压缩包内每个业务文件均为可正常打开的 PDF 文件，不能仅修改文件扩展名，也不要嵌套其他压缩包。");
  }
  if (reasonCodes.includes("classification") || reasons.some((reason) => /增补|补充|Supplement/u.test(reason))) {
    guidance.push(`请把安全数据表（SDS）、制造商规范、定制组件规范及安全培训证书等补充材料合并为一个 PDF，并命名为“${schoolName}-EDP增补文件”。`);
  }
  return `${schoolName}参赛队：

你好！

中国大学生Chem-E-Car®竞赛组委会已经收到你校EDP，但你校本次未成功提交${settings.competitionYear}年Chem-E-Car®竞赛EDP（第${settings.submissionRound}次），原因如下：
${issueLines}

${guidance.join("\n\n")}

请在指定时间前于官网www.chemecar.cn重新提交EDP。

${signature}`;
}

function makeEdpReceipt(
  schoolName: string,
  sourceStatus: "qualified" | "unqualified",
  fileCount: number,
  reasonCodes: EdpReasonCode[],
  rawReasons: string[],
  settings: EdpReceiptSettings,
  recipientEmail: string,
  assessedAt: string,
) {
  const settingsComplete = edpReceiptSettingsComplete(settings);
  const reasons = edpReceiptReasons(fileCount, reasonCodes, rawReasons, settings);
  const expectedCount = edpExpectedFileCount(settings);
  const status = !settingsComplete
    ? "needs_configuration" as const
    : sourceStatus === "qualified" && fileCount === expectedCount
      ? "qualified" as const
      : "unqualified" as const;
  return {
    status,
    recipientEmail,
    subject: edpReceiptSubject(schoolName, status),
    body: settingsComplete
      ? edpReceiptBody(schoolName, status === "qualified" ? "qualified" : "unqualified", settings, reasons, reasonCodes)
      : "",
    settingsComplete,
    competitionYear: settings.competitionYear,
    submissionRound: settings.submissionRound,
    expectedFileCount: expectedCount,
    reasons,
    assessedAt,
  };
}

function edpSubmissionFromRow(
  row: EdpSubmissionRow,
  receiptSettings: EdpReceiptSettings = DEFAULT_EDP_RECEIPT_SETTINGS,
  recipientEmail = "",
) {
  const submissionRound = isEdpSubmissionRound(row.submission_round) ? row.submission_round : null;
  const archiveFormat: EdpArchiveFormat = row.archive_format === "7z" || row.archive_format === "rar" ? row.archive_format : "zip";
  const documentRoles = submissionRound === null
    ? []
    : submissionRound === 1
      ? ["chinese_edp", "english_edp", "supplement"]
      : ["chinese_edp", "english_edp", "supplement", "moc"];
  return {
    schoolKey: row.school_key,
    schoolName: row.school_name,
    filename: row.filename,
    submittedAt: row.submitted_at,
    submissionId: row.submission_id,
    size: row.size,
    fileCount: row.file_count,
    uploadedAt: row.uploaded_at,
    archiveFormat,
    submissionRound,
    submissionRoundSource: row.submission_round_source || "legacy_unknown",
    documentRoles,
    embeddedRegistration: {
      filename: row.embedded_registration_filename ?? null,
      status: row.embedded_registration_status || "none",
      message: row.embedded_registration_message ?? null,
    },
    reviewTaskStatus: row.has_review_job === 1 ? "created" : "missing",
    downloadUrl: `/api/edp-submissions/${encodeURIComponent(row.school_key)}/download`,
    receipt: makeEdpReceipt(
      row.school_name,
      "qualified",
      row.file_count,
      [],
      [],
      receiptSettings,
      recipientEmail,
      row.uploaded_at,
    ),
  };
}

function parsedStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function edpIssueFromRow(
  row: EdpIssueRow,
  receiptSettings: EdpReceiptSettings = DEFAULT_EDP_RECEIPT_SETTINGS,
  recipientEmail = "",
) {
  const validCodes = new Set<EdpReasonCode>(["file_count", "file_format", "classification"]);
  const reasonCodes = parsedStringArray(row.reason_codes_json).filter((code): code is EdpReasonCode => validCodes.has(code as EdpReasonCode));
  return {
    schoolKey: row.school_key,
    schoolName: row.school_name,
    filename: row.filename,
    submittedAt: row.submitted_at,
    submissionId: row.submission_id,
    fileCount: row.file_count,
    reasonCode: row.reason_code,
    reasonCodes,
    reasons: parsedStringArray(row.reasons_json),
    createdAt: row.created_at,
    message: "文件未收集，仅保留问题记录。",
    receipt: makeEdpReceipt(
      row.school_name,
      "unqualified",
      row.file_count,
      reasonCodes,
      parsedStringArray(row.reasons_json),
      receiptSettings,
      recipientEmail,
      row.created_at,
    ),
  };
}

async function getSettings(db: D1Database, userId: string): Promise<CollectorSettings> {
  const row = await db.prepare(`
    SELECT starts_at, run_time, timezone, interval_minutes, enabled, next_run_at
    FROM collector_settings
    WHERE user_id = ?
  `).bind(userId).first<SettingsRow>();
  return settingsFromRow(row);
}

async function getEdpSettings(db: D1Database, userId: string): Promise<CollectorSettings> {
  const row = await db.prepare(`
    SELECT starts_at, run_time, timezone, interval_minutes, enabled, next_run_at
    FROM edp_settings
    WHERE user_id = ?
  `).bind(userId).first<SettingsRow>();
  return settingsFromRow(row);
}

async function getMediaSettings(
  db: D1Database,
  userId: string,
  kind: "poster" | "video",
): Promise<CollectorSettings> {
  const row = await db.prepare(`
    SELECT starts_at, run_time, timezone, interval_minutes, enabled, next_run_at
    FROM media_collector_settings
    WHERE user_id = ? AND kind = ?
  `).bind(userId, kind).first<SettingsRow>();
  return settingsFromRow(row);
}

async function dashboard(request: Request, env: Env, userId: string): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);

  const [
    settings,
    registrationReceiptSettings,
    master,
    registrationsResult,
    edpSettings,
    edpReceiptSettings,
    edpSubmissionsResult,
    edpIssuesResult,
    posters,
    videos,
    posterSettings,
    videoSettings,
    mail,
    fanke,
  ] = await Promise.all([
    getSettings(env.DB, userId),
    getRegistrationReceiptSettings(env.DB, userId),
    env.DB.prepare(`
      SELECT r2_key, filename, size, uploaded_at
      FROM collector_master_files
      WHERE user_id = ?
    `).bind(userId).first<MasterRow>(),
    env.DB.prepare(`
      SELECT registration.school_key, registration.school_name, registration.r2_key, registration.filename,
             registration.submitted_at, registration.submission_id, registration.size, registration.uploaded_at,
             receipt.status AS receipt_status, receipt.recipient_email AS receipt_email,
             receipt.teacher_count AS receipt_teacher_count, receipt.student_count AS receipt_student_count,
             receipt.reasons_json AS receipt_reasons_json, receipt.assessed_at AS receipt_assessed_at
      FROM collector_registrations AS registration
      LEFT JOIN registration_receipts AS receipt
        ON receipt.user_id = registration.user_id AND receipt.school_key = registration.school_key
           AND receipt.submission_id = registration.submission_id
      WHERE registration.user_id = ?
      ORDER BY registration.school_name COLLATE NOCASE, registration.school_key
    `).bind(userId).all<RegistrationRow>(),
    getEdpSettings(env.DB, userId),
    getEdpReceiptSettings(env.DB, userId),
    env.DB.prepare(`
      SELECT school_key, school_name, r2_key, filename, content_type, submitted_at, submission_id, size, file_count, uploaded_at,
             submission_round, submission_round_source, archive_format,
             embedded_registration_filename, embedded_registration_status, embedded_registration_message,
             CASE WHEN EXISTS (
               SELECT 1 FROM edp_review_jobs AS review
               WHERE review.user_id = edp_submissions.user_id
                 AND review.school_key = edp_submissions.school_key
                 AND review.submission_id = edp_submissions.submission_id
                 AND review.status <> 'superseded'
             ) THEN 1 ELSE 0 END AS has_review_job
      FROM edp_submissions
      WHERE user_id = ?
      ORDER BY school_name COLLATE NOCASE, school_key
    `).bind(userId).all<EdpSubmissionRow>(),
    env.DB.prepare(`
      SELECT school_key, school_name, filename, submitted_at, submission_id, file_count,
             reason_code, reason_codes_json, reasons_json, created_at
      FROM edp_issues
      WHERE user_id = ?
      ORDER BY created_at DESC, school_name COLLATE NOCASE
    `).bind(userId).all<EdpIssueRow>(),
    listMediaAssets(env.DB, userId, "poster"),
    listMediaAssets(env.DB, userId, "video"),
    getMediaSettings(env.DB, userId, "poster"),
    getMediaSettings(env.DB, userId, "video"),
    getMailDashboard(env, userId),
    getFankeDashboard(env, userId),
  ]);

  const registrations = registrationsResult.results.map((row) => registrationFromRow(row, registrationReceiptSettings));
  const registrationEmailBySchool = new Map(registrationsResult.results.map((row) => [row.school_key, row.receipt_email ?? ""]));
  const edpSubmissions = edpSubmissionsResult.results.map((row) => edpSubmissionFromRow(
    row,
    edpReceiptSettings,
    registrationEmailBySchool.get(row.school_key) ?? "",
  ));
  const edpIssues = edpIssuesResult.results.map((row) => edpIssueFromRow(
    row,
    edpReceiptSettings,
    registrationEmailBySchool.get(row.school_key) ?? "",
  ));
  return json({
    ok: true,
    settings,
    registrationReceiptSettings,
    master: masterFromRow(master),
    registrations,
    edpSettings,
    edpReceiptSettings,
    edpSubmissions,
    edpIssues,
    media: { posters, videos, settings: { poster: posterSettings, video: videoSettings } },
    mediaSettings: { poster: posterSettings, video: videoSettings },
    mail,
    fanke,
    summary: {
      schoolCount: registrations.length,
      hasMaster: Boolean(master),
      enabled: settings.enabled,
      edpSchoolCount: edpSubmissions.length,
      edpIssueCount: edpIssues.length,
      edpEnabled: edpSettings.enabled,
      posterSchoolCount: posters.length,
      videoSchoolCount: videos.length,
      posterEnabled: posterSettings.enabled,
      videoEnabled: videoSettings.enabled,
    },
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNullableDate(value: unknown, fieldName: string, dateOnly = false): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new ApiError(400, "invalid_settings", `${fieldName} 格式不正确。`);
  const input = value.trim();

  if (dateOnly && /^\d{4}-\d{2}-\d{2}$/.test(input)) {
    const [year, month, day] = input.split("-").map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
      throw new ApiError(400, "invalid_settings", `${fieldName} 不是有效日期。`);
    }
    return input;
  }

  const timestamp = Date.parse(input);
  if (!Number.isFinite(timestamp)) throw new ApiError(400, "invalid_settings", `${fieldName} 不是有效日期。`);
  return new Date(timestamp).toISOString();
}

function parseTime(value: unknown): string {
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.trim())) {
    throw new ApiError(400, "invalid_settings", "runTime 必须使用 HH:MM 格式。");
  }
  return value.trim();
}

function parseTimezone(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 100) {
    throw new ApiError(400, "invalid_settings", "timezone 格式不正确。");
  }
  const timezone = value.trim();
  try {
    new Intl.DateTimeFormat("zh-CN", { timeZone: timezone }).format();
  } catch {
    throw new ApiError(400, "invalid_settings", "timezone 不是有效时区。");
  }
  return "Asia/Shanghai";
}

function zonedStartTimestamp(startsAt: string, runTime: string, timezone: string): number {
  const date = startsAt.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (!date) throw new ApiError(400, "invalid_settings", "startsAt 不是有效的开始日期。");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = runTime.split(":").map(Number);
  const desiredWallClock = Date.UTC(year, month - 1, day, hour, minute);
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
  return candidate;
}

function calculateNextRunAt(settings: CollectorSettings, now = Date.now()): string | null {
  if (!settings.enabled || !settings.startsAt) return null;
  const firstRun = zonedStartTimestamp(settings.startsAt, settings.runTime, settings.timezone);
  const intervalMs = settings.intervalMinutes * 60_000;
  if (firstRun > now) return new Date(firstRun).toISOString();
  const elapsedIntervals = Math.floor((now - firstRun) / intervalMs) + 1;
  return new Date(firstRun + elapsedIntervals * intervalMs).toISOString();
}

function submissionDateInTimezone(submittedAt: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(submittedAt));
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function enforceCollectionStart(
  settings: CollectorSettings,
  submittedAt: string,
  label: string,
): void {
  if (!settings.startsAt) return;
  let submittedDate: string;
  try {
    submittedDate = submissionDateInTimezone(submittedAt, settings.timezone);
  } catch {
    throw new ApiError(500, "invalid_settings", `${label}采集起始日期的时区配置无效，请重新保存计划。`);
  }
  if (submittedDate < settings.startsAt) {
    throw new ApiError(
      422,
      "before_collection_start",
      `该文件提交日期早于${label}栏目设置的收集起始日期，文件未收集。`,
    );
  }
}

async function updateSettings(request: Request, env: Env, userId: string): Promise<Response> {
  if (request.method !== "PUT") return methodNotAllowed(["PUT"]);
  if (!request.headers.get("Content-Type")?.toLowerCase().includes("application/json")) {
    throw new ApiError(415, "unsupported_media_type", "设置必须以 JSON 格式提交。");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiError(400, "invalid_json", "设置内容不是有效的 JSON。");
  }
  if (!isPlainObject(body)) throw new ApiError(400, "invalid_settings", "设置内容必须是一个对象。");

  const current = await getSettings(env.DB, userId);
  const settings: CollectorSettings = {
    startsAt: "startsAt" in body ? parseNullableDate(body.startsAt, "startsAt", true) : current.startsAt,
    runTime: "runTime" in body ? parseTime(body.runTime) : current.runTime,
    timezone: "timezone" in body ? parseTimezone(body.timezone) : "Asia/Shanghai",
    intervalMinutes: current.intervalMinutes,
    enabled: current.enabled,
    nextRunAt: "nextRunAt" in body ? parseNullableDate(body.nextRunAt, "nextRunAt") : current.nextRunAt,
  };

  if ("intervalMinutes" in body) {
    if (!Number.isInteger(body.intervalMinutes) || (body.intervalMinutes as number) < 1 || (body.intervalMinutes as number) > 525600) {
      throw new ApiError(400, "invalid_settings", "intervalMinutes 必须是 1 至 525600 之间的整数。");
    }
    settings.intervalMinutes = body.intervalMinutes as number;
  }
  if ("enabled" in body) {
    if (typeof body.enabled !== "boolean") throw new ApiError(400, "invalid_settings", "enabled 必须是布尔值。");
    settings.enabled = body.enabled;
  }

  if (settings.enabled && !settings.startsAt) {
    throw new ApiError(400, "start_date_required", "启用采集前必须设置 startsAt。");
  }
  if (!("nextRunAt" in body)) settings.nextRunAt = calculateNextRunAt(settings);
  if (!settings.enabled) settings.nextRunAt = null;

  const updatedAt = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO collector_settings (
      user_id, starts_at, run_time, timezone, interval_minutes, enabled, next_run_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      starts_at = excluded.starts_at,
      run_time = excluded.run_time,
      timezone = excluded.timezone,
      interval_minutes = excluded.interval_minutes,
      enabled = excluded.enabled,
      next_run_at = excluded.next_run_at,
      updated_at = excluded.updated_at
  `).bind(
    userId,
    settings.startsAt,
    settings.runTime,
    settings.timezone,
    settings.intervalMinutes,
    settings.enabled ? 1 : 0,
    settings.nextRunAt,
    updatedAt,
  ).run();

  await requeueFankeFilesForKind(env.DB, userId, "registration");

  return json({ ok: true, settings });
}

async function updateRegistrationReceiptSettings(request: Request, env: Env, userId: string): Promise<Response> {
  if (request.method !== "PUT") return methodNotAllowed(["PUT"]);
  if (!request.headers.get("Content-Type")?.toLowerCase().includes("application/json")) {
    throw new ApiError(415, "unsupported_media_type", "报名回执设置必须以 JSON 格式提交。");
  }
  const body = await request.json().catch(() => null);
  if (!isPlainObject(body)) throw new ApiError(400, "invalid_settings", "报名回执设置内容必须是一个对象。");
  const competitionYear = typeof body.competitionYear === "string" ? body.competitionYear.normalize("NFKC").trim() : "";
  const qqGroup = typeof body.qqGroup === "string" ? body.qqGroup.normalize("NFKC").trim() : "";
  if (!/^20\d{2}$/u.test(competitionYear)) {
    throw new ApiError(400, "invalid_competition_year", "竞赛年份为必填项，请填写四位年份，例如 2026。");
  }
  if (!/^\d{5,20}$/u.test(qqGroup)) {
    throw new ApiError(400, "invalid_qq_group", "交流 QQ 群号为必填项，请填写 5 至 20 位数字。");
  }
  const updatedAt = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO registration_receipt_settings (
    user_id, competition_year, qq_group, updated_at
  ) VALUES (?, ?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET
    competition_year = excluded.competition_year,
    qq_group = excluded.qq_group,
    updated_at = excluded.updated_at`)
    .bind(userId, competitionYear, qqGroup, updatedAt).run();
  return json({
    ok: true,
    settings: { competitionYear, qqGroup, updatedAt },
    message: "报名回执设置已保存；报名表清单中的成功回执会立即使用新年份和群号。",
  });
}

async function updateEdpReceiptSettings(request: Request, env: Env, userId: string): Promise<Response> {
  if (request.method !== "PUT") return methodNotAllowed(["PUT"]);
  if (!request.headers.get("Content-Type")?.toLowerCase().includes("application/json")) {
    throw new ApiError(415, "unsupported_media_type", "EDP 回执设置必须以 JSON 格式提交。");
  }
  const body = await request.json().catch(() => null);
  if (!isPlainObject(body)) throw new ApiError(400, "invalid_settings", "EDP 回执设置内容必须是一个对象。");
  const competitionYear = typeof body.competitionYear === "string" ? body.competitionYear.normalize("NFKC").trim() : "";
  const submissionRound = typeof body.submissionRound === "number" ? body.submissionRound : Number(body.submissionRound);
  if (!/^20\d{2}$/u.test(competitionYear)) {
    throw new ApiError(400, "invalid_competition_year", "竞赛年份为必填项，请填写四位年份，例如 2026。");
  }
  if (!isEdpSubmissionRound(submissionRound)) {
    throw new ApiError(400, "invalid_submission_round", "请选择第 1 次至第 5 次 EDP 提交。");
  }
  const updatedAt = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO edp_receipt_settings (
    user_id, competition_year, submission_round, updated_at
  ) VALUES (?, ?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET
    competition_year = excluded.competition_year,
    submission_round = excluded.submission_round,
    updated_at = excluded.updated_at`)
    .bind(userId, competitionYear, submissionRound, updatedAt).run();
  return json({
    ok: true,
    settings: { competitionYear, submissionRound, updatedAt },
    message: `EDP 回执设置已保存；系统将按第 ${submissionRound} 次提交的 ${submissionRound === 1 ? "3 个 PDF" : "4 个 PDF（含 MOC）"}规则检查并生成回执。`,
  });
}

async function updateEdpSettings(request: Request, env: Env, userId: string): Promise<Response> {
  if (request.method !== "PUT") return methodNotAllowed(["PUT"]);
  if (!request.headers.get("Content-Type")?.toLowerCase().includes("application/json")) {
    throw new ApiError(415, "unsupported_media_type", "EDP 设置必须以 JSON 格式提交。");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiError(400, "invalid_json", "EDP 设置内容不是有效的 JSON。");
  }
  if (!isPlainObject(body)) throw new ApiError(400, "invalid_settings", "EDP 设置内容必须是一个对象。");

  const current = await getEdpSettings(env.DB, userId);
  const settings: CollectorSettings = {
    startsAt: "startsAt" in body ? parseNullableDate(body.startsAt, "startsAt", true) : current.startsAt,
    runTime: "runTime" in body ? parseTime(body.runTime) : current.runTime,
    timezone: "timezone" in body ? parseTimezone(body.timezone) : "Asia/Shanghai",
    intervalMinutes: current.intervalMinutes,
    enabled: current.enabled,
    nextRunAt: "nextRunAt" in body ? parseNullableDate(body.nextRunAt, "nextRunAt") : current.nextRunAt,
  };

  if ("intervalMinutes" in body) {
    if (!Number.isInteger(body.intervalMinutes) || (body.intervalMinutes as number) < 1 || (body.intervalMinutes as number) > 525600) {
      throw new ApiError(400, "invalid_settings", "intervalMinutes 必须是 1 至 525600 之间的整数。");
    }
    settings.intervalMinutes = body.intervalMinutes as number;
  }
  if ("enabled" in body) {
    if (typeof body.enabled !== "boolean") throw new ApiError(400, "invalid_settings", "enabled 必须是布尔值。");
    settings.enabled = body.enabled;
  }
  if (settings.enabled && !settings.startsAt) {
    throw new ApiError(400, "start_date_required", "启用 EDP 采集前必须设置 startsAt。");
  }
  if (!("nextRunAt" in body)) settings.nextRunAt = calculateNextRunAt(settings);
  if (!settings.enabled) settings.nextRunAt = null;

  const updatedAt = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO edp_settings (
      user_id, starts_at, run_time, timezone, interval_minutes, enabled, next_run_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      starts_at = excluded.starts_at,
      run_time = excluded.run_time,
      timezone = excluded.timezone,
      interval_minutes = excluded.interval_minutes,
      enabled = excluded.enabled,
      next_run_at = excluded.next_run_at,
      updated_at = excluded.updated_at
  `).bind(
    userId,
    settings.startsAt,
    settings.runTime,
    settings.timezone,
    settings.intervalMinutes,
    settings.enabled ? 1 : 0,
    settings.nextRunAt,
    updatedAt,
  ).run();

  await requeueFankeFilesForKind(env.DB, userId, "edp");

  return json({ ok: true, edpSettings: settings });
}

async function updateMediaSettings(
  request: Request,
  env: Env,
  userId: string,
  kind: "poster" | "video",
): Promise<Response> {
  if (request.method !== "PUT") return methodNotAllowed(["PUT"]);
  if (!request.headers.get("Content-Type")?.toLowerCase().includes("application/json")) {
    throw new ApiError(415, "unsupported_media_type", "媒体采集设置必须以 JSON 格式提交。");
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiError(400, "invalid_json", "媒体采集设置不是有效的 JSON。");
  }
  if (!isPlainObject(body)) throw new ApiError(400, "invalid_settings", "媒体采集设置必须是一个对象。");
  const current = await getMediaSettings(env.DB, userId, kind);
  const settings: CollectorSettings = {
    startsAt: "startsAt" in body ? parseNullableDate(body.startsAt, "startsAt", true) : current.startsAt,
    runTime: "runTime" in body ? parseTime(body.runTime) : current.runTime,
    timezone: "timezone" in body ? parseTimezone(body.timezone) : "Asia/Shanghai",
    intervalMinutes: current.intervalMinutes,
    enabled: current.enabled,
    nextRunAt: "nextRunAt" in body ? parseNullableDate(body.nextRunAt, "nextRunAt") : current.nextRunAt,
  };
  if ("intervalMinutes" in body) {
    if (!Number.isInteger(body.intervalMinutes) || (body.intervalMinutes as number) < 1 || (body.intervalMinutes as number) > 525600) {
      throw new ApiError(400, "invalid_settings", "intervalMinutes 必须是 1 至 525600 之间的整数。");
    }
    settings.intervalMinutes = body.intervalMinutes as number;
  }
  if ("enabled" in body) {
    if (typeof body.enabled !== "boolean") throw new ApiError(400, "invalid_settings", "enabled 必须是布尔值。");
    settings.enabled = body.enabled;
  }
  if (settings.enabled && !settings.startsAt) {
    throw new ApiError(400, "start_date_required", `启用${kind === "poster" ? "海报" : "视频"}采集前必须设置 startsAt。`);
  }
  if (!("nextRunAt" in body)) settings.nextRunAt = calculateNextRunAt(settings);
  if (!settings.enabled) settings.nextRunAt = null;
  const updatedAt = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO media_collector_settings (
      user_id, kind, starts_at, run_time, timezone, interval_minutes, enabled, next_run_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, kind) DO UPDATE SET
      starts_at = excluded.starts_at,
      run_time = excluded.run_time,
      timezone = excluded.timezone,
      interval_minutes = excluded.interval_minutes,
      enabled = excluded.enabled,
      next_run_at = excluded.next_run_at,
      updated_at = excluded.updated_at
  `).bind(
    userId, kind, settings.startsAt, settings.runTime, settings.timezone,
    settings.intervalMinutes, settings.enabled ? 1 : 0, settings.nextRunAt, updatedAt,
  ).run();
  await requeueFankeFilesForKind(env.DB, userId, kind);
  return json({ ok: true, kind, settings, mediaSettings: settings });
}

function readXlsxFile(form: FormData, message: string): File {
  const candidate = form.get("file");
  if (!(candidate instanceof File)) throw new ApiError(400, "file_required", message);
  if (!candidate.name.toLowerCase().endsWith(".xlsx")) {
    throw new ApiError(415, "xlsx_required", "仅支持 .xlsx 格式的 Excel 文件。");
  }
  if (candidate.size <= 0) throw new ApiError(400, "empty_file", "上传的 Excel 文件为空。");
  if (candidate.size > MAX_UPLOAD_BYTES) throw new ApiError(413, "file_too_large", "Excel 文件不能超过 20MB。");
  return candidate;
}

async function readMultipartForm(request: Request): Promise<FormData> {
  const contentType = request.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.includes("multipart/form-data")) {
    throw new ApiError(415, "unsupported_media_type", "请使用表单方式上传文件。");
  }
  try {
    return await request.formData();
  } catch {
    throw new ApiError(400, "invalid_form", "无法读取上传内容。");
  }
}

async function userStorageKey(userId: string): Promise<string> {
  const bytes = new TextEncoder().encode(userId);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function uploadMaster(request: Request, env: Env, userId: string): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  const form = await readMultipartForm(request);
  const file = readXlsxFile(form, "请选择要上传的主统计表。");
  const storageUser = await userStorageKey(userId);
  const r2Key = `users/${storageUser}/master/current.xlsx`;
  const uploadedAt = new Date().toISOString();

  await env.FILES.put(r2Key, file.stream(), { httpMetadata: { contentType: XLSX_CONTENT_TYPE } });
  await env.DB.prepare(`
    INSERT INTO collector_master_files (user_id, r2_key, filename, content_type, size, uploaded_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      r2_key = excluded.r2_key,
      filename = excluded.filename,
      content_type = excluded.content_type,
      size = excluded.size,
      uploaded_at = excluded.uploaded_at
  `).bind(userId, r2Key, file.name, XLSX_CONTENT_TYPE, file.size, uploadedAt).run();

  return json({
    ok: true,
    master: masterFromRow({ r2_key: r2Key, filename: file.name, size: file.size, uploaded_at: uploadedAt }),
  }, 201);
}

type MasterSyncResult =
  | { status: "updated"; message: string; sheetName: string; rowNumber: number }
  | { status: "not-configured"; message: string }
  | { status: "not-qualified"; message: string }
  | { status: "failed"; message: string; code: string };

async function syncMasterWithRegistration(
  env: Env,
  userId: string,
  schoolName: string,
  registrationFile: File,
): Promise<MasterSyncResult> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const master = await env.DB.prepare(`SELECT r2_key, filename, size, uploaded_at
      FROM collector_master_files WHERE user_id = ?`).bind(userId).first<MasterRow>();
    if (!master) {
      return { status: "not-configured", message: "报名表已保存；上传唯一统计表后，新报名会自动写入该表。" };
    }
    const current = await env.FILES.get(master.r2_key);
    if (!current) {
      return { status: "failed", code: "master_file_missing", message: "报名表已保存，但唯一统计表的云端文件缺失，请重新上传统计表。" };
    }

    let updated: Awaited<ReturnType<typeof updateMasterWorkbook>>;
    try {
      const [masterBytes, registrationBytes] = await Promise.all([
        current.arrayBuffer(),
        registrationFile.arrayBuffer(),
      ]);
      updated = await updateMasterWorkbook(masterBytes, registrationBytes, schoolName);
    } catch (error) {
      if (error instanceof RegistrationWorkbookError) {
        return { status: "failed", code: error.code, message: `报名表已保存，但统计表未更新：${error.message}` };
      }
      throw error;
    }

    const onlyIf = new Headers({ "If-Match": current.httpEtag });
    const uploadedAt = new Date().toISOString();
    const stored = await env.FILES.put(master.r2_key, updated.bytes, {
      onlyIf,
      httpMetadata: { contentType: XLSX_CONTENT_TYPE },
      customMetadata: {
        lastSyncedSchool: encodeURIComponent(updated.summary.schoolName),
        lastSyncedAt: uploadedAt,
      },
    });
    if (!stored) continue;

    await env.DB.prepare(`UPDATE collector_master_files
      SET size = ?, uploaded_at = ? WHERE user_id = ? AND r2_key = ?`)
      .bind(updated.bytes.byteLength, uploadedAt, userId, master.r2_key).run();
    return {
      status: "updated",
      message: `${updated.summary.schoolName} 的报名信息已写入唯一统计表。`,
      sheetName: updated.sheetName,
      rowNumber: updated.rowNumber,
    };
  }
  return { status: "failed", code: "master_concurrent_update", message: "报名表已保存，但统计表正在被另一份报名更新，请稍后重新上传本报名表。" };
}

function canonicalSchoolKey(schoolName: string): string {
  const schoolKey = schoolName.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[\s\p{P}\p{S}]+/gu, "");
  if (!schoolKey || schoolKey.length > 160) throw new ApiError(400, "invalid_school_name", "学校名称无法生成有效标识。");
  return schoolKey;
}

function normalizeSchoolName(value: FormDataEntryValue | null): string {
  if (typeof value !== "string") throw new ApiError(400, "school_name_required", "缺少学校名称 schoolName。");
  const schoolName = normalizeCompetitionSchoolName(value);
  if (!schoolName || schoolName.length > 200) throw new ApiError(400, "invalid_school_name", "schoolName 格式不正确。");
  return schoolName;
}

function normalizeSubmittedAt(value: FormDataEntryValue | null): string {
  if (typeof value !== "string" || !value.trim()) throw new ApiError(400, "submitted_at_required", "缺少提交时间 submittedAt。");
  const timestamp = Date.parse(value.trim());
  if (!Number.isFinite(timestamp)) throw new ApiError(400, "invalid_submitted_at", "submittedAt 不是有效日期。");
  return new Date(timestamp).toISOString();
}

function normalizeSubmissionId(value: FormDataEntryValue | null): string {
  if (typeof value !== "string") throw new ApiError(400, "submission_id_required", "缺少提交编号 submissionId。");
  const submissionId = value.normalize("NFKC").trim();
  if (!submissionId || submissionId.length > 200) throw new ApiError(400, "invalid_submission_id", "submissionId 格式不正确。");
  return submissionId;
}

function uploadMetadata(
  form: FormData,
  filename: string,
): { schoolName: string; submittedAt: string; submissionId: string; manual: boolean } {
  const values = [form.get("schoolName"), form.get("submittedAt"), form.get("submissionId")];
  const hasExplicitMetadata = values.some((value) => typeof value === "string" && value.trim().length > 0);
  if (hasExplicitMetadata) {
    return {
      schoolName: normalizeSchoolName(values[0]),
      submittedAt: normalizeSubmittedAt(values[1]),
      submissionId: normalizeSubmissionId(values[2]),
      manual: false,
    };
  }
  try {
    return { ...manualFileMetadata(filename), manual: true };
  } catch (error) {
    throw new ApiError(
      400,
      "school_name_not_in_filename",
      error instanceof Error ? error.message : "无法从文件名识别学校，请按“学校名称-资料类型”重命名后重试。",
    );
  }
}

function compareSubmissionIds(left: string, right: string): number {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    const normalizedLeft = left.replace(/^0+(?=\d)/, "");
    const normalizedRight = right.replace(/^0+(?=\d)/, "");
    if (normalizedLeft.length !== normalizedRight.length) return normalizedLeft.length > normalizedRight.length ? 1 : -1;
    if (normalizedLeft !== normalizedRight) return normalizedLeft > normalizedRight ? 1 : -1;
    return 0;
  }
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

function isNewerSubmission(
  submittedAt: string,
  submissionId: string,
  current: Pick<RegistrationRow, "submitted_at" | "submission_id">,
): boolean {
  const incomingTime = Date.parse(submittedAt);
  const currentTime = Date.parse(current.submitted_at);
  if (incomingTime !== currentTime) return incomingTime > currentTime;
  return compareSubmissionIds(submissionId, current.submission_id) > 0;
}

async function storeRegistrationIfNewest(
  env: Env,
  r2Key: string,
  file: File,
  submittedAt: string,
  submissionId: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const currentObject = await env.FILES.head(r2Key);
    const currentSubmittedAt = currentObject?.customMetadata?.submittedAt;
    const encodedCurrentId = currentObject?.customMetadata?.submissionId;
    if (currentSubmittedAt && encodedCurrentId) {
      try {
        const currentSubmissionId = decodeURIComponent(encodedCurrentId);
        const currentVersion = {
          submitted_at: currentSubmittedAt,
          submission_id: currentSubmissionId,
        };
        if (submittedAt === currentVersion.submitted_at && compareSubmissionIds(submissionId, currentVersion.submission_id) === 0) {
          // A previous request may have written R2 before D1 failed. Treat the
          // same version as stored so the caller can repair the D1 index.
          return true;
        }
        if (!isNewerSubmission(submittedAt, submissionId, currentVersion)) return false;
      } catch {
        // Ignore malformed legacy metadata and rely on the D1 version check.
      }
    }

    const onlyIf = new Headers();
    if (currentObject) onlyIf.set("If-Match", currentObject.httpEtag);
    else onlyIf.set("If-None-Match", "*");
    const stored = await env.FILES.put(r2Key, file.stream(), {
      onlyIf,
      httpMetadata: { contentType: XLSX_CONTENT_TYPE },
      customMetadata: {
        submittedAt,
        submissionId: encodeURIComponent(submissionId),
      },
    });
    if (stored) return true;
  }
  throw new ApiError(409, "concurrent_update", "该学校正在接收另一份新报名表，请稍后重试。");
}

async function registrationRecord(
  db: D1Database,
  userId: string,
  schoolKey: string,
): Promise<RegistrationRow | null> {
  return db.prepare(`SELECT registration.school_key, registration.school_name, registration.r2_key,
      registration.filename, registration.submitted_at, registration.submission_id,
      registration.size, registration.uploaded_at,
      receipt.status AS receipt_status, receipt.recipient_email AS receipt_email,
      receipt.teacher_count AS receipt_teacher_count, receipt.student_count AS receipt_student_count,
      receipt.reasons_json AS receipt_reasons_json, receipt.assessed_at AS receipt_assessed_at
    FROM collector_registrations AS registration
    LEFT JOIN registration_receipts AS receipt
      ON receipt.user_id = registration.user_id AND receipt.school_key = registration.school_key
         AND receipt.submission_id = registration.submission_id
    WHERE registration.user_id = ? AND registration.school_key = ?`)
    .bind(userId, schoolKey).first<RegistrationRow>();
}

async function saveRegistrationReceiptIfCurrent(
  db: D1Database,
  userId: string,
  schoolKey: string,
  schoolName: string,
  submittedAt: string,
  submissionId: string,
  assessment: RegistrationAssessment,
): Promise<boolean> {
  const assessedAt = new Date().toISOString();
  const saved = await db.prepare(`INSERT INTO registration_receipts (
      user_id, school_key, school_name, submission_id, recipient_email, status,
      teacher_count, student_count, reasons_json, assessed_at
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM collector_registrations
      WHERE user_id = ? AND school_key = ? AND submitted_at = ? AND submission_id = ?
    )
    ON CONFLICT(user_id, school_key) DO UPDATE SET
      school_name = excluded.school_name,
      submission_id = excluded.submission_id,
      recipient_email = excluded.recipient_email,
      status = excluded.status,
      teacher_count = excluded.teacher_count,
      student_count = excluded.student_count,
      reasons_json = excluded.reasons_json,
      assessed_at = excluded.assessed_at
    RETURNING school_key`)
    .bind(
      userId,
      schoolKey,
      schoolName,
      submissionId,
      assessment.summary.teamEmail,
      assessment.qualified ? "qualified" : "unqualified",
      assessment.teacherCount,
      assessment.studentCount,
      JSON.stringify(assessment.reasons),
      assessedAt,
      userId,
      schoolKey,
      submittedAt,
      submissionId,
    ).first<{ school_key: string }>();
  return Boolean(saved);
}

function unqualifiedMasterSync(assessment: RegistrationAssessment): MasterSyncResult {
  return {
    status: "not-qualified",
    message: `报名表已保存，但检查未通过，统计表未更新；请查看报名未成功回执。${assessment.reasons[0] ? ` ${assessment.reasons[0]}` : ""}`,
  };
}

interface RegistrationIngestResult {
  accepted: boolean;
  created: boolean;
  reason?: "duplicate" | "older-or-equal" | "superseded";
  message?: string;
  masterSync?: MasterSyncResult;
  row: RegistrationRow;
  assessment: RegistrationAssessment;
}

async function ingestRegistrationFile(
  env: Env,
  userId: string,
  input: {
    file: File;
    schoolName: string;
    submittedAt: string;
    submissionId: string;
    enforceStart: boolean;
  },
): Promise<RegistrationIngestResult> {
  const { file, schoolName, submittedAt, submissionId } = input;
  const schoolKey = canonicalSchoolKey(schoolName);
  const assessment = assessRegistrationWorkbook(await file.arrayBuffer(), schoolName);
  if (input.enforceStart) enforceCollectionStart(await getSettings(env.DB, userId), submittedAt, "报名表");
  const existing = await registrationRecord(env.DB, userId, schoolKey);

  if (existing && !isNewerSubmission(submittedAt, submissionId, existing)) {
    const sameVersion = existing.submitted_at === submittedAt && existing.submission_id === submissionId;
    let masterSync: MasterSyncResult | undefined;
    let current = existing;
    if (sameVersion) {
      await saveRegistrationReceiptIfCurrent(env.DB, userId, schoolKey, schoolName, submittedAt, submissionId, assessment);
      masterSync = assessment.qualified
        ? await syncMasterWithRegistration(env, userId, schoolName, file)
        : unqualifiedMasterSync(assessment);
      current = await registrationRecord(env.DB, userId, schoolKey) ?? existing;
    }
    return {
      accepted: false,
      created: false,
      reason: sameVersion ? "duplicate" : "older-or-equal",
      message: sameVersion
        ? masterSync?.message ?? "该报名表已是此学校的当前版本。"
        : "该报名表不是此学校的更新版本，当前文件未被覆盖。",
      ...(masterSync ? { masterSync } : {}),
      row: current,
      assessment,
    };
  }

  const storageUser = await userStorageKey(userId);
  const r2Key = `users/${storageUser}/registrations/${encodeURIComponent(schoolKey)}/current.xlsx`;
  const uploadedAt = new Date().toISOString();
  const stored = await storeRegistrationIfNewest(env, r2Key, file, submittedAt, submissionId);
  if (!stored) {
    const current = await registrationRecord(env.DB, userId, schoolKey);
    if (!current) throw new ApiError(409, "concurrent_update", "该学校的更新版本正在保存，请稍后刷新。");
    return {
      accepted: false,
      created: false,
      reason: "older-or-equal",
      message: "该报名表不是此学校的更新版本，当前文件未被覆盖。",
      row: current,
      assessment,
    };
  }
  await env.DB.prepare(`
    INSERT INTO collector_registrations (
      user_id, school_key, school_name, r2_key, filename, content_type,
      submitted_at, submission_id, size, uploaded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, school_key) DO UPDATE SET
      school_name = excluded.school_name,
      r2_key = excluded.r2_key,
      filename = excluded.filename,
      content_type = excluded.content_type,
      submitted_at = excluded.submitted_at,
      submission_id = excluded.submission_id,
      size = excluded.size,
      uploaded_at = excluded.uploaded_at
    WHERE excluded.submitted_at > collector_registrations.submitted_at
       OR (
         excluded.submitted_at = collector_registrations.submitted_at
         AND CASE
           WHEN excluded.submission_id <> ''
            AND collector_registrations.submission_id <> ''
            AND excluded.submission_id NOT GLOB '*[^0-9]*'
            AND collector_registrations.submission_id NOT GLOB '*[^0-9]*'
           THEN CASE
             WHEN LENGTH(LTRIM(excluded.submission_id, '0')) <> LENGTH(LTRIM(collector_registrations.submission_id, '0'))
             THEN LENGTH(LTRIM(excluded.submission_id, '0')) > LENGTH(LTRIM(collector_registrations.submission_id, '0'))
             ELSE LTRIM(excluded.submission_id, '0') > LTRIM(collector_registrations.submission_id, '0')
           END
           ELSE excluded.submission_id > collector_registrations.submission_id
         END
       )
  `).bind(
    userId, schoolKey, schoolName, r2Key, file.name, XLSX_CONTENT_TYPE,
    submittedAt, submissionId, file.size, uploadedAt,
  ).run();

  let saved = await registrationRecord(env.DB, userId, schoolKey);
  if (!saved) throw new ApiError(500, "registration_metadata_missing", "报名表已保存，但索引更新失败。");
  const accepted = saved.submitted_at === submittedAt && saved.submission_id === submissionId;
  if (accepted) {
    const receiptSaved = await saveRegistrationReceiptIfCurrent(
      env.DB,
      userId,
      schoolKey,
      schoolName,
      submittedAt,
      submissionId,
      assessment,
    );
    if (!receiptSaved) throw new ApiError(409, "registration_changed", "报名表已被更新，请刷新后重试生成回执。");
    saved = await registrationRecord(env.DB, userId, schoolKey) ?? saved;
  }
  const masterSync = accepted
    ? assessment.qualified
      ? await syncMasterWithRegistration(env, userId, schoolName, file)
      : unqualifiedMasterSync(assessment)
    : undefined;
  return {
    accepted,
    created: accepted && !existing,
    ...(accepted
      ? { message: masterSync?.message, masterSync }
      : { reason: "superseded", message: "保存过程中收到了更新版本，系统已保留较新的一份。" }),
    row: saved,
    assessment,
  };
}

async function uploadRegistration(request: Request, env: Env, userId: string): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  const form = await readMultipartForm(request);
  const file = readXlsxFile(form, "请选择报名表 Excel 文件。");
  const metadata = uploadMetadata(form, file.name);
  let result: RegistrationIngestResult;
  try {
    result = await ingestRegistrationFile(env, userId, {
      file,
      schoolName: metadata.schoolName,
      submittedAt: metadata.submittedAt,
      submissionId: metadata.submissionId,
      enforceStart: !metadata.manual,
    });
  } catch (error) {
    if (error instanceof RegistrationWorkbookError) {
      throw new ApiError(422, error.code, error.message);
    }
    throw error;
  }
  const receiptSettings = await getRegistrationReceiptSettings(env.DB, userId);
  return json({
    ok: true,
    accepted: result.accepted,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.message ? { message: result.message } : {}),
    ...(result.masterSync ? { masterSync: result.masterSync } : {}),
    registration: registrationFromRow(result.row, receiptSettings),
  }, result.created ? 201 : 200);
}

async function refreshRegistrationReceipt(
  request: Request,
  env: Env,
  userId: string,
  encodedKey: string,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  const schoolKey = decodedSchoolKey(encodedKey);
  const body = await request.json().catch(() => null);
  if (!isPlainObject(body)) throw new ApiError(400, "invalid_json", "生成回执请求格式不正确。");
  const expected = expectedVersion(body);
  const current = await registrationRecord(env.DB, userId, schoolKey);
  if (!current) throw new ApiError(404, "registration_not_found", "未找到该学校的报名表。");
  if (current.submitted_at !== expected.submittedAt || current.submission_id !== expected.submissionId) {
    throw new ApiError(409, "registration_changed", "报名表已被更新，请刷新后重新生成回执。");
  }
  const stored = await env.FILES.get(current.r2_key);
  if (!stored) throw new ApiError(409, "registration_file_missing", "报名表云端文件缺失，请重新采集或补录后再生成回执。");
  let assessment: RegistrationAssessment;
  let workbookBytes: ArrayBuffer;
  try {
    workbookBytes = await stored.arrayBuffer();
    assessment = assessRegistrationWorkbook(workbookBytes, current.school_name);
  } catch (error) {
    if (error instanceof RegistrationWorkbookError) throw new ApiError(422, error.code, error.message);
    throw error;
  }
  const receiptSaved = await saveRegistrationReceiptIfCurrent(
    env.DB,
    userId,
    schoolKey,
    current.school_name,
    current.submitted_at,
    current.submission_id,
    assessment,
  );
  if (!receiptSaved) throw new ApiError(409, "registration_changed", "报名表已被更新，请刷新后重新生成回执。");
  const masterSync = assessment.qualified
    ? await syncMasterWithRegistration(
      env,
      userId,
      current.school_name,
      new File([workbookBytes], current.filename, { type: XLSX_CONTENT_TYPE }),
    )
    : unqualifiedMasterSync(assessment);
  const [updated, settings] = await Promise.all([
    registrationRecord(env.DB, userId, schoolKey),
    getRegistrationReceiptSettings(env.DB, userId),
  ]);
  if (!updated) throw new ApiError(404, "registration_not_found", "报名表已被删除，请刷新清单。");
  return json({
    ok: true,
    registration: registrationFromRow(updated, settings),
    masterSync,
    message: `${assessment.qualified ? "报名成功回执已生成。" : "报名未成功回执已生成，请查看检查原因。"} ${masterSync.message}`,
  });
}

function edpFailure(fileCount: number, entries: Array<[EdpReasonCode, string]>): EdpValidationResult {
  const reasons: string[] = [];
  const reasonCodes: EdpReasonCode[] = [];
  for (const [code, reason] of entries) {
    if (!reasonCodes.includes(code)) reasonCodes.push(code);
    if (!reasons.includes(reason)) reasons.push(reason);
  }
  const reasonCode = reasonCodes.includes("file_format")
    ? "file_format"
    : reasonCodes.includes("file_count")
      ? "file_count"
      : "classification";
  return { qualified: false, fileCount, reasonCode, reasonCodes, reasons };
}

function edpInspectionFailure(error: unknown): EdpValidationResult {
  if (error instanceof EdpArchiveError) return edpFailure(0, [["file_format", error.message]]);
  return edpFailure(0, [["file_format", "压缩包损坏、已加密，或无法读取。"]]);
}

function prepareEdpSubmissionUpsert(db: D1Database, userId: string, row: EdpSubmissionRow) {
  return db.prepare(`
    INSERT INTO edp_submissions (
      user_id, school_key, school_name, r2_key, filename, content_type,
      submitted_at, submission_id, size, file_count, uploaded_at,
      submission_round, submission_round_source, archive_format,
      embedded_registration_filename, embedded_registration_status, embedded_registration_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, school_key) DO UPDATE SET
      school_name = excluded.school_name,
      r2_key = excluded.r2_key,
      filename = excluded.filename,
      content_type = excluded.content_type,
      submitted_at = excluded.submitted_at,
      submission_id = excluded.submission_id,
      size = excluded.size,
      file_count = excluded.file_count,
      uploaded_at = excluded.uploaded_at,
      submission_round = excluded.submission_round,
      submission_round_source = excluded.submission_round_source,
      archive_format = excluded.archive_format,
      embedded_registration_filename = excluded.embedded_registration_filename,
      embedded_registration_status = excluded.embedded_registration_status,
      embedded_registration_message = excluded.embedded_registration_message
    WHERE excluded.submitted_at > edp_submissions.submitted_at
       OR (
         excluded.submitted_at = edp_submissions.submitted_at
         AND CASE
           WHEN excluded.submission_id <> ''
            AND edp_submissions.submission_id <> ''
            AND excluded.submission_id NOT GLOB '*[^0-9]*'
            AND edp_submissions.submission_id NOT GLOB '*[^0-9]*'
           THEN CASE
             WHEN LENGTH(LTRIM(excluded.submission_id, '0')) <> LENGTH(LTRIM(edp_submissions.submission_id, '0'))
             THEN LENGTH(LTRIM(excluded.submission_id, '0')) > LENGTH(LTRIM(edp_submissions.submission_id, '0'))
             ELSE LTRIM(excluded.submission_id, '0') > LTRIM(edp_submissions.submission_id, '0')
           END
           ELSE excluded.submission_id > edp_submissions.submission_id
         END
       )
  `).bind(
    userId,
    row.school_key,
    row.school_name,
    row.r2_key,
    row.filename,
    row.content_type,
    row.submitted_at,
    row.submission_id,
    row.size,
    row.file_count,
    row.uploaded_at,
    row.submission_round,
    row.submission_round_source,
    row.archive_format,
    row.embedded_registration_filename,
    row.embedded_registration_status,
    row.embedded_registration_message,
  );
}

function prepareDeleteEdpIssueThroughVersion(
  db: D1Database,
  userId: string,
  schoolKey: string,
  submittedAt: string,
  submissionId: string,
) {
  return db.prepare(`
    DELETE FROM edp_issues
    WHERE user_id = ? AND school_key = ?
      AND (
        submitted_at < ?
        OR (
          submitted_at = ?
          AND CASE
            WHEN submission_id <> '' AND ? <> ''
             AND submission_id NOT GLOB '*[^0-9]*'
             AND ? NOT GLOB '*[^0-9]*'
            THEN CASE
              WHEN LENGTH(LTRIM(submission_id, '0')) <> LENGTH(LTRIM(?, '0'))
              THEN LENGTH(LTRIM(submission_id, '0')) < LENGTH(LTRIM(?, '0'))
              ELSE LTRIM(submission_id, '0') <= LTRIM(?, '0')
            END
            ELSE submission_id <= ?
          END
        )
      )
  `).bind(
    userId,
    schoolKey,
    submittedAt,
    submittedAt,
    submissionId,
    submissionId,
    submissionId,
    submissionId,
    submissionId,
    submissionId,
  );
}

async function persistQualifiedEdp(env: Env, userId: string, row: EdpSubmissionRow): Promise<void> {
  await env.DB.batch([
    prepareEdpSubmissionUpsert(env.DB, userId, row),
    prepareDeleteEdpIssueThroughVersion(env.DB, userId, row.school_key, row.submitted_at, row.submission_id),
  ]);
}

async function recordEdpIssue(
  env: Env,
  userId: string,
  schoolKey: string,
  schoolName: string,
  filename: string,
  submittedAt: string,
  submissionId: string,
  validation: EdpValidationResult,
): Promise<EdpIssueRow | null> {
  const createdAt = new Date().toISOString();
  const reasonCode = validation.reasonCode ?? "classification";
  const upsertIssue = env.DB.prepare(`
    INSERT INTO edp_issues (
      user_id, school_key, school_name, filename, submitted_at, submission_id,
      file_count, reason_code, reason_codes_json, reasons_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, school_key) DO UPDATE SET
      school_name = excluded.school_name,
      filename = excluded.filename,
      submitted_at = excluded.submitted_at,
      submission_id = excluded.submission_id,
      file_count = excluded.file_count,
      reason_code = excluded.reason_code,
      reason_codes_json = excluded.reason_codes_json,
      reasons_json = excluded.reasons_json,
      created_at = excluded.created_at
    WHERE excluded.submitted_at > edp_issues.submitted_at
       OR (
         excluded.submitted_at = edp_issues.submitted_at
         AND CASE
           WHEN excluded.submission_id <> ''
            AND edp_issues.submission_id <> ''
            AND excluded.submission_id NOT GLOB '*[^0-9]*'
            AND edp_issues.submission_id NOT GLOB '*[^0-9]*'
           THEN CASE
             WHEN LENGTH(LTRIM(excluded.submission_id, '0')) <> LENGTH(LTRIM(edp_issues.submission_id, '0'))
             THEN LENGTH(LTRIM(excluded.submission_id, '0')) > LENGTH(LTRIM(edp_issues.submission_id, '0'))
             ELSE LTRIM(excluded.submission_id, '0') > LTRIM(edp_issues.submission_id, '0')
           END
           ELSE excluded.submission_id > edp_issues.submission_id
         END
       )
  `).bind(
    userId,
    schoolKey,
    schoolName,
    filename,
    submittedAt,
    submissionId,
    validation.fileCount,
    reasonCode,
    JSON.stringify(validation.reasonCodes),
    JSON.stringify(validation.reasons),
    createdAt,
  );

  const removeIssueHiddenByQualified = env.DB.prepare(`
    DELETE FROM edp_issues
    WHERE user_id = ? AND school_key = ?
      AND EXISTS (
        SELECT 1 FROM edp_submissions
        WHERE edp_submissions.user_id = edp_issues.user_id
          AND edp_submissions.school_key = edp_issues.school_key
          AND (
            edp_submissions.submitted_at > edp_issues.submitted_at
            OR (
              edp_submissions.submitted_at = edp_issues.submitted_at
              AND CASE
                WHEN edp_submissions.submission_id <> ''
                 AND edp_issues.submission_id <> ''
                 AND edp_submissions.submission_id NOT GLOB '*[^0-9]*'
                 AND edp_issues.submission_id NOT GLOB '*[^0-9]*'
                THEN CASE
                  WHEN LENGTH(LTRIM(edp_submissions.submission_id, '0')) <> LENGTH(LTRIM(edp_issues.submission_id, '0'))
                  THEN LENGTH(LTRIM(edp_submissions.submission_id, '0')) > LENGTH(LTRIM(edp_issues.submission_id, '0'))
                  ELSE LTRIM(edp_submissions.submission_id, '0') >= LTRIM(edp_issues.submission_id, '0')
                END
                ELSE edp_submissions.submission_id >= edp_issues.submission_id
              END
            )
          )
      )
  `).bind(userId, schoolKey);

  await env.DB.batch([upsertIssue, removeIssueHiddenByQualified]);
  return env.DB.prepare(`
    SELECT school_key, school_name, filename, submitted_at, submission_id, file_count,
           reason_code, reason_codes_json, reasons_json, created_at
    FROM edp_issues
    WHERE user_id = ? AND school_key = ?
  `).bind(userId, schoolKey).first<EdpIssueRow>();
}

function edpRowFromObject(
  object: { customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string }; size: number; uploaded: Date },
  r2Key: string,
  schoolKey: string,
): EdpSubmissionRow | null {
  const metadata = object.customMetadata;
  if (!metadata?.submittedAt || !metadata.submissionId || !metadata.schoolName || !metadata.filename) return null;
  const fileCount = Number(metadata.fileCount);
  if (!Number.isInteger(fileCount) || fileCount < 3 || fileCount > 4) return null;
  const rawRound = Number(metadata.submissionRound);
  const submissionRound = isEdpSubmissionRound(rawRound) ? rawRound : null;
  const archiveFormat: EdpArchiveFormat = metadata.archiveFormat === "7z" || metadata.archiveFormat === "rar"
    ? metadata.archiveFormat
    : "zip";
  const roundSource = metadata.submissionRoundSource;
  const submissionRoundSource: EdpSubmissionRow["submission_round_source"] = roundSource === "captured"
    || roundSource === "inferred_file_count"
    || roundSource === "inferred_current_setting"
    ? roundSource
    : "legacy_unknown";
  return {
    school_key: schoolKey,
    school_name: metadata.schoolName,
    r2_key: r2Key,
    filename: metadata.filename,
    content_type: metadata.contentType || object.httpMetadata?.contentType || ZIP_CONTENT_TYPE,
    submitted_at: metadata.submittedAt,
    submission_id: metadata.submissionId,
    size: object.size,
    file_count: fileCount,
    uploaded_at: object.uploaded.toISOString(),
    submission_round: submissionRound,
    submission_round_source: submissionRoundSource,
    archive_format: archiveFormat,
    embedded_registration_filename: null,
    embedded_registration_status: "none",
    embedded_registration_message: null,
  };
}

async function storeEdpIfNewest(
  env: Env,
  userId: string,
  r2Key: string,
  schoolKey: string,
  schoolName: string,
  filename: string,
  file: File,
  fileCount: number,
  contentType: string,
  submissionRound: EdpSubmissionRound | null,
  archiveFormat: EdpArchiveFormat,
  submittedAt: string,
  submissionId: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const currentObject = await env.FILES.head(r2Key);
    const currentSubmittedAt = currentObject?.customMetadata?.submittedAt;
    const currentSubmissionId = currentObject?.customMetadata?.submissionId;
    if (currentObject && currentSubmittedAt && currentSubmissionId) {
      const currentVersion = { submitted_at: currentSubmittedAt, submission_id: currentSubmissionId };
      if (submittedAt === currentSubmittedAt && compareSubmissionIds(submissionId, currentSubmissionId) === 0) return true;
      if (!isNewerSubmission(submittedAt, submissionId, currentVersion)) {
        const healed = edpRowFromObject(currentObject, r2Key, schoolKey);
        if (healed) await persistQualifiedEdp(env, userId, healed);
        return false;
      }
    }

    const onlyIf = new Headers();
    if (currentObject) onlyIf.set("If-Match", currentObject.httpEtag);
    else onlyIf.set("If-None-Match", "*");
    const stored = await env.FILES.put(r2Key, file.stream(), {
      onlyIf,
      httpMetadata: { contentType },
      customMetadata: {
        submittedAt,
        submissionId,
        schoolName,
        filename,
        fileCount: String(fileCount),
        contentType,
        submissionRound: submissionRound === null ? "" : String(submissionRound),
        submissionRoundSource: submissionRound === null ? "legacy_unknown" : "captured",
        archiveFormat,
      },
    });
    if (stored) return true;
  }
  throw new ApiError(409, "concurrent_update", "该学校正在接收另一份 EDP，请稍后重试。");
}

function edpArchiveContentType(format: EdpArchiveFormat): string {
  if (format === "7z") return "application/x-7z-compressed";
  if (format === "rar") return "application/vnd.rar";
  return ZIP_CONTENT_TYPE;
}

function packageValidation(inspection: EdpPackageInspection): EdpValidationResult {
  return {
    qualified: inspection.qualified,
    fileCount: inspection.coreFileCount,
    ...(inspection.reasonCode ? { reasonCode: inspection.reasonCode } : {}),
    reasonCodes: inspection.reasonCodes,
    reasons: inspection.reasons,
  };
}

async function syncEmbeddedRegistration(
  env: Env,
  userId: string,
  edp: EdpSubmissionRow,
  candidates: readonly EdpRegistrationCandidate[],
): Promise<{
  filename: string | null;
  status: "none" | "synced" | "older" | "invalid";
  message: string | null;
}> {
  let result: {
    filename: string | null;
    status: "none" | "synced" | "older" | "invalid";
    message: string | null;
  };
  if (candidates.length === 0) {
    result = { filename: null, status: "none", message: null };
  } else if (candidates.length > 1) {
    result = {
      filename: null,
      status: "invalid",
      message: `压缩包内有 ${candidates.length} 份报名表，只允许携带一份：${candidates.map(({ displayPath }) => displayPath).join("；")}。`,
    };
  } else {
    const candidate = candidates[0];
    const filename = candidate.displayPath.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) || "报名表.xlsx";
    try {
      const ingested = await ingestRegistrationFile(env, userId, {
        file: new File([new Uint8Array(candidate.bytes)], filename, { type: XLSX_CONTENT_TYPE }),
        schoolName: edp.school_name,
        submittedAt: edp.submitted_at,
        submissionId: edp.submission_id,
        enforceStart: false,
      });
      if (ingested.masterSync?.status === "failed") {
        result = { filename, status: "invalid", message: ingested.masterSync.message };
      } else if (ingested.accepted || ingested.reason === "duplicate") {
        result = {
          filename,
          status: "synced",
          message: ingested.assessment.qualified
            ? "压缩包内报名表已更新到报名表栏目，并已生成报名成功回执。"
            : "压缩包内报名表已更新到报名表栏目；报名检查未通过，已生成具体的未成功回执。",
        };
      } else {
        result = { filename, status: "older", message: "压缩包内报名表不比报名表栏目中的当前版本新，未覆盖。" };
      }
    } catch (error) {
      const message = error instanceof RegistrationWorkbookError || error instanceof ApiError
        ? error.message
        : "压缩包内报名表无法读取，EDP 已保留，请人工核对报名表。";
      result = { filename, status: "invalid", message };
    }
  }

  await env.DB.prepare(`UPDATE edp_submissions
    SET embedded_registration_filename = ?, embedded_registration_status = ?, embedded_registration_message = ?
    WHERE user_id = ? AND school_key = ? AND submitted_at = ? AND submission_id = ?`)
    .bind(
      result.filename,
      result.status,
      result.message,
      userId,
      edp.school_key,
      edp.submitted_at,
      edp.submission_id,
    ).run();
  return result;
}

async function uploadEdpSubmission(
  request: Request,
  env: Env,
  userId: string,
  options: { skipCollectionStart?: boolean } = {},
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  const form = await readMultipartForm(request);
  const candidate = form.get("file");
  if (!(candidate instanceof File)) throw new ApiError(400, "file_required", "请选择 EDP ZIP、7z 或 RAR 压缩包。");
  const metadata = uploadMetadata(form, candidate.name);
  const schoolName = metadata.schoolName;
  const schoolKey = canonicalSchoolKey(schoolName);
  const submittedAt = metadata.submittedAt;
  const submissionId = metadata.submissionId;
  if (!metadata.manual && !options.skipCollectionStart) {
    enforceCollectionStart(await getEdpSettings(env.DB, userId), submittedAt, "EDP");
  }
  const normalizedFilename = candidate.name.normalize("NFKC").replace(/[\r\n\0]/g, "_") || "EDP.zip";
  const filename = normalizedFilename.slice(0, 240);

  const [existingSubmission, existingIssue, receiptSettings, registrationReceipt] = await Promise.all([
    env.DB.prepare(`
      SELECT school_key, school_name, r2_key, filename, content_type, submitted_at, submission_id, size, file_count, uploaded_at,
             submission_round, submission_round_source, archive_format,
             embedded_registration_filename, embedded_registration_status, embedded_registration_message
      FROM edp_submissions
      WHERE user_id = ? AND school_key = ?
    `).bind(userId, schoolKey).first<EdpSubmissionRow>(),
    env.DB.prepare(`
      SELECT school_key, school_name, filename, submitted_at, submission_id, file_count,
             reason_code, reason_codes_json, reasons_json, created_at
      FROM edp_issues
      WHERE user_id = ? AND school_key = ?
    `).bind(userId, schoolKey).first<EdpIssueRow>(),
    getEdpReceiptSettings(env.DB, userId),
    env.DB.prepare(`SELECT recipient_email
      FROM registration_receipts
      WHERE user_id = ? AND school_key = ?`)
      .bind(userId, schoolKey).first<{ recipient_email: string }>(),
  ]);
  let recipientEmail = registrationReceipt?.recipient_email ?? "";
  const submissionPayload = (row: EdpSubmissionRow) => edpSubmissionFromRow(row, receiptSettings, recipientEmail);
  const issuePayload = (row: EdpIssueRow) => edpIssueFromRow(row, receiptSettings, recipientEmail);

  if (!edpReceiptSettingsComplete(receiptSettings)) {
    throw new ApiError(409, "edp_receipt_settings_required", "请先保存竞赛年份和第几次 EDP 提交，再开始收集压缩包。");
  }

  let archiveBytes = new Uint8Array();
  let inspection: EdpPackageInspection | null = null;
  let validation: EdpValidationResult;
  if (normalizedFilename.length > 240) {
    validation = edpFailure(0, [["file_format", "EDP 压缩包文件名过长，请缩短至 240 个字符以内。"]]);
  } else if (candidate.size <= 0) {
    validation = edpFailure(0, [["file_format", "EDP 压缩包为空。"]]);
  } else if (candidate.size > MAX_UPLOAD_BYTES) {
    validation = edpFailure(0, [["file_format", "EDP ZIP、7z 或 RAR 压缩包不能超过 20MB。"]]);
  } else {
    archiveBytes = new Uint8Array(await candidate.arrayBuffer());
    try {
      inspection = await inspectEdpPackage(archiveBytes, filename, receiptSettings.submissionRound, {
        validatePdfContents: true,
      });
      validation = packageValidation(inspection);
    } catch (error) {
      validation = edpInspectionFailure(error);
    }
  }
  if (!validation.qualified) {
    if (existingIssue && !isNewerSubmission(submittedAt, submissionId, existingIssue)) {
      return json({
        ok: true,
        accepted: false,
        qualified: null,
        reason: "older-or-equal",
        message: "该不合格 EDP 提交不比当前问题记录新，未重复记录。",
        issue: issuePayload(existingIssue),
        ...(existingSubmission ? { submission: submissionPayload(existingSubmission) } : {}),
      });
    }
    const savedIssue = await recordEdpIssue(
      env, userId, schoolKey, schoolName, filename, submittedAt, submissionId, validation,
    );
    if (!savedIssue) {
      const currentSubmission = await env.DB.prepare(`
        SELECT school_key, school_name, r2_key, filename, content_type, submitted_at, submission_id, size, file_count, uploaded_at,
               submission_round, submission_round_source, archive_format,
               embedded_registration_filename, embedded_registration_status, embedded_registration_message
        FROM edp_submissions
        WHERE user_id = ? AND school_key = ?
      `).bind(userId, schoolKey).first<EdpSubmissionRow>();
      return json({
        ok: true,
        accepted: false,
        qualified: null,
        reason: "superseded",
        message: "校验期间收到了更新且合格的 EDP；当前不合格文件未收集，也未保留问题记录。",
        ...(currentSubmission ? { submission: submissionPayload(currentSubmission) } : {}),
      });
    }
    return json({
      ok: true,
      accepted: false,
      qualified: false,
      reason: "invalid-package",
      message: "文件未收集，仅保留问题记录。",
      issue: issuePayload(savedIssue),
    });
  }

  // Invalid submissions never block an older-but-newest qualified package.
  // Compare qualified archives only with the school's previously accepted archive.
  if (existingSubmission && !isNewerSubmission(submittedAt, submissionId, existingSubmission)) {
    return json({
      ok: true,
      accepted: false,
      qualified: null,
      reason: "older-or-equal",
      message: "该合格 EDP 不比当前已收集的合格版本新，未覆盖文件。",
      submission: submissionPayload(existingSubmission),
      ...(existingIssue ? { issue: issuePayload(existingIssue) } : {}),
    });
  }

  const storageUser = await userStorageKey(userId);
  const r2Key = `users/${storageUser}/edp/${encodeURIComponent(schoolKey)}/current.zip`;
  const uploadedAt = new Date().toISOString();
  if (!inspection?.archiveFormat) throw new ApiError(500, "edp_inspection_missing", "EDP 已通过检查，但解析结果缺失，请重试。");
  const archiveFormat = inspection.archiveFormat;
  const contentType = edpArchiveContentType(archiveFormat);
  const archiveFile = new File([archiveBytes], filename, { type: contentType });
  const stored = await storeEdpIfNewest(
    env, userId, r2Key, schoolKey, schoolName, filename, archiveFile, validation.fileCount,
    contentType, receiptSettings.submissionRound, archiveFormat, submittedAt, submissionId,
  );
  if (!stored) {
    const current = await env.DB.prepare(`
      SELECT school_key, school_name, r2_key, filename, content_type, submitted_at, submission_id, size, file_count, uploaded_at,
             submission_round, submission_round_source, archive_format,
             embedded_registration_filename, embedded_registration_status, embedded_registration_message
      FROM edp_submissions
      WHERE user_id = ? AND school_key = ?
    `).bind(userId, schoolKey).first<EdpSubmissionRow>();
    if (!current) throw new ApiError(409, "concurrent_update", "该学校的更新版 EDP 正在保存，请稍后刷新。");
    return json({
      ok: true,
      accepted: false,
      qualified: null,
      reason: "older-or-equal",
      message: "该 EDP 不比存储中的版本新，当前压缩包未被覆盖。",
      submission: submissionPayload(current),
    });
  }

  const row: EdpSubmissionRow = {
    school_key: schoolKey,
    school_name: schoolName,
    r2_key: r2Key,
    filename,
    content_type: contentType,
    submitted_at: submittedAt,
    submission_id: submissionId,
    size: candidate.size,
    file_count: validation.fileCount,
    uploaded_at: uploadedAt,
    submission_round: receiptSettings.submissionRound,
    submission_round_source: "captured",
    archive_format: archiveFormat,
    embedded_registration_filename: null,
    embedded_registration_status: "none",
    embedded_registration_message: null,
  };
  await persistQualifiedEdp(env, userId, row);
  const saved = await env.DB.prepare(`
    SELECT school_key, school_name, r2_key, filename, content_type, submitted_at, submission_id, size, file_count, uploaded_at,
           submission_round, submission_round_source, archive_format,
           embedded_registration_filename, embedded_registration_status, embedded_registration_message
    FROM edp_submissions
    WHERE user_id = ? AND school_key = ?
  `).bind(userId, schoolKey).first<EdpSubmissionRow>();
  if (!saved) throw new ApiError(500, "edp_metadata_missing", "EDP 已保存，但索引更新失败。");
  const accepted = saved.submitted_at === submittedAt && compareSubmissionIds(saved.submission_id, submissionId) === 0;
  if (accepted) {
    const embeddedRegistration = await syncEmbeddedRegistration(
      env,
      userId,
      saved,
      inspection.registrationCandidates,
    );
    saved.embedded_registration_filename = embeddedRegistration.filename;
    saved.embedded_registration_status = embeddedRegistration.status;
    saved.embedded_registration_message = embeddedRegistration.message;
    const currentReceipt = await env.DB.prepare(`SELECT recipient_email
      FROM registration_receipts
      WHERE user_id = ? AND school_key = ?`)
      .bind(userId, schoolKey).first<{ recipient_email: string }>();
    recipientEmail = currentReceipt?.recipient_email ?? recipientEmail;
  }
  let reviewJob: Awaited<ReturnType<typeof queueEdpReviewForSubmission>> | null = null;
  let reviewQueueError: string | null = null;
  if (accepted && receiptSettings.submissionRound !== null) {
    try {
      reviewJob = await queueEdpReviewForSubmission(env, userId, {
        schoolKey: saved.school_key,
        schoolName: saved.school_name,
        submissionId: saved.submission_id,
        submittedAt: saved.submitted_at,
        submissionRound: receiptSettings.submissionRound,
        sourceR2Key: saved.r2_key,
        sourceFilename: saved.filename,
      });
    } catch (error) {
      console.error("Could not queue EDP review", error);
      reviewQueueError = "EDP 已收集，但审核任务暂未建立；请稍后在 EDP 审核栏目重试。";
    }
  }
  if (accepted) saved.has_review_job = reviewJob ? 1 : 0;
  return json({
    ok: true,
    accepted,
    qualified: accepted ? true : null,
    ...(accepted ? {} : { reason: "superseded", message: "保存过程中收到了更新版本，系统已保留较新的合格 EDP。" }),
    ...(reviewJob ? { reviewJob } : {}),
    ...(reviewQueueError ? { reviewQueueError } : {}),
    submission: submissionPayload(saved),
  }, accepted && !existingSubmission ? 201 : 200);
}

function contentDisposition(filename: string): string {
  const safeAscii = filename.replace(/[\r\n"]/g, "_").replace(/[^\x20-\x7E]/g, "_") || "download";
  return `attachment; filename="${safeAscii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function downloadStoredFile(
  env: Env,
  r2Key: string,
  filename: string,
  contentType = XLSX_CONTENT_TYPE,
): Promise<Response> {
  const object = await env.FILES.get(r2Key);
  if (!object) throw new ApiError(404, "file_not_found", "文件记录存在，但存储中的文件未找到。");
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", contentType);
  headers.set("Content-Disposition", contentDisposition(filename));
  headers.set("Content-Length", String(object.size));
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("ETag", object.httpEtag);
  return new Response(object.body, { headers });
}

async function downloadMaster(request: Request, env: Env, userId: string): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  const master = await env.DB.prepare(`
    SELECT r2_key, filename, size, uploaded_at
    FROM collector_master_files
    WHERE user_id = ?
  `).bind(userId).first<MasterRow>();
  if (!master) throw new ApiError(404, "master_not_found", "尚未上传主统计表。");
  return downloadStoredFile(env, master.r2_key, master.filename);
}

async function downloadRegistration(
  request: Request,
  env: Env,
  userId: string,
  encodedSchoolKey: string,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  let schoolKey: string;
  try {
    schoolKey = canonicalSchoolKey(decodeURIComponent(encodedSchoolKey));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "invalid_school_key", "学校标识无法识别。");
  }
  const registration = await env.DB.prepare(`
    SELECT school_key, school_name, r2_key, filename, submitted_at, submission_id, size, uploaded_at
    FROM collector_registrations
    WHERE user_id = ? AND school_key = ?
  `).bind(userId, schoolKey).first<RegistrationRow>();
  if (!registration) throw new ApiError(404, "registration_not_found", "未找到该学校的报名表。");
  return downloadStoredFile(env, registration.r2_key, registration.filename);
}

async function downloadEdpSubmission(
  request: Request,
  env: Env,
  userId: string,
  encodedSchoolKey: string,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  let schoolKey: string;
  try {
    schoolKey = canonicalSchoolKey(decodeURIComponent(encodedSchoolKey));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "invalid_school_key", "学校标识无法识别。");
  }
  const submission = await env.DB.prepare(`
    SELECT school_key, school_name, r2_key, filename, content_type, submitted_at, submission_id, size, file_count, uploaded_at,
           submission_round, submission_round_source, archive_format,
           embedded_registration_filename, embedded_registration_status, embedded_registration_message
    FROM edp_submissions
    WHERE user_id = ? AND school_key = ?
  `).bind(userId, schoolKey).first<EdpSubmissionRow>();
  if (!submission) throw new ApiError(404, "edp_submission_not_found", "未找到该学校的合格 EDP 压缩包。");
  return downloadStoredFile(env, submission.r2_key, submission.filename, submission.content_type || ZIP_CONTENT_TYPE);
}

async function deleteBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("Content-Type")?.toLocaleLowerCase("en-US").includes("application/json")) {
    throw new ApiError(415, "unsupported_media_type", "删除请求必须使用 JSON 格式。" );
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "invalid_json", "删除确认内容不是有效的 JSON。" );
  }
  return body as Record<string, unknown>;
}

function expectedVersion(body: Record<string, unknown>): { submittedAt: string; submissionId: string } {
  return {
    submittedAt: normalizeSubmittedAt(typeof body.submittedAt === "string" ? body.submittedAt : null),
    submissionId: normalizeSubmissionId(typeof body.submissionId === "string" ? body.submissionId : null),
  };
}

function decodedSchoolKey(value: string): string {
  try { return canonicalSchoolKey(decodeURIComponent(value)); }
  catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "invalid_school_key", "学校标识无法识别。" );
  }
}

async function deleteMaster(request: Request, env: Env, userId: string): Promise<Response> {
  if (request.method !== "DELETE") return methodNotAllowed(["DELETE"]);
  const body = await deleteBody(request);
  const expectedUploadedAt = parseNullableDate(body.uploadedAt, "uploadedAt");
  if (!expectedUploadedAt) throw new ApiError(400, "uploaded_at_required", "缺少要删除文件的上传时间。" );
  const current = await env.DB.prepare(`SELECT r2_key, filename, size, uploaded_at FROM collector_master_files WHERE user_id = ?`)
    .bind(userId).first<MasterRow>();
  if (!current) throw new ApiError(404, "master_not_found", "尚未上传主统计表。" );
  if (current.uploaded_at !== expectedUploadedAt) throw new ApiError(409, "master_changed", "主统计表已被更新；请刷新后重新确认删除。" );
  const result = await env.DB.prepare(`DELETE FROM collector_master_files WHERE user_id = ? AND uploaded_at = ?`)
    .bind(userId, expectedUploadedAt).run();
  if ((result.meta.changes ?? 0) !== 1) throw new ApiError(409, "master_changed", "主统计表已被更新；请刷新后重新确认删除。" );
  await env.FILES.delete(current.r2_key).catch((error) => console.error("Could not remove orphaned master object", error));
  return json({ ok: true, deleted: true });
}

async function deleteRegistration(request: Request, env: Env, userId: string, encodedKey: string): Promise<Response> {
  if (request.method !== "DELETE") return methodNotAllowed(["DELETE"]);
  const schoolKey = decodedSchoolKey(encodedKey);
  const expected = expectedVersion(await deleteBody(request));
  const current = await env.DB.prepare(`SELECT school_key, school_name, r2_key, filename, submitted_at, submission_id, size, uploaded_at
    FROM collector_registrations WHERE user_id = ? AND school_key = ?`).bind(userId, schoolKey).first<RegistrationRow>();
  if (!current) throw new ApiError(404, "registration_not_found", "未找到该学校的报名表。" );
  if (current.submitted_at !== expected.submittedAt || current.submission_id !== expected.submissionId) {
    throw new ApiError(409, "registration_changed", "报名表已被更新；请刷新后重新确认删除。" );
  }
  const result = await env.DB.prepare(`DELETE FROM collector_registrations
    WHERE user_id = ? AND school_key = ? AND submitted_at = ? AND submission_id = ?`)
    .bind(userId, schoolKey, expected.submittedAt, expected.submissionId).run();
  if ((result.meta.changes ?? 0) !== 1) throw new ApiError(409, "registration_changed", "报名表已被更新；请刷新后重新确认删除。" );
  await env.DB.prepare(`DELETE FROM registration_receipts WHERE user_id = ? AND school_key = ?`)
    .bind(userId, schoolKey).run();
  await env.FILES.delete(current.r2_key).catch((error) => console.error("Could not remove orphaned registration object", error));
  return json({ ok: true, deleted: true, schoolKey });
}

async function deleteEdpSubmission(request: Request, env: Env, userId: string, encodedKey: string): Promise<Response> {
  if (request.method !== "DELETE") return methodNotAllowed(["DELETE"]);
  const schoolKey = decodedSchoolKey(encodedKey);
  const expected = expectedVersion(await deleteBody(request));
  const current = await env.DB.prepare(`SELECT school_key, school_name, r2_key, filename, content_type, submitted_at, submission_id, size, file_count, uploaded_at,
           submission_round, submission_round_source, archive_format,
           embedded_registration_filename, embedded_registration_status, embedded_registration_message
    FROM edp_submissions WHERE user_id = ? AND school_key = ?`).bind(userId, schoolKey).first<EdpSubmissionRow>();
  if (!current) throw new ApiError(404, "edp_submission_not_found", "未找到该学校的合格 EDP。" );
  if (current.submitted_at !== expected.submittedAt || current.submission_id !== expected.submissionId) {
    throw new ApiError(409, "edp_changed", "EDP 已被更新；请刷新后重新确认删除。" );
  }
  const result = await deleteEdpSubmissionAndReviews(env, userId, {
    schoolKey,
    submittedAt: expected.submittedAt,
    submissionId: expected.submissionId,
  });
  if (!result.deleted) throw new ApiError(409, "edp_changed", "EDP 已被更新；请刷新后重新确认删除。" );
  return json({ ok: true, deleted: true, schoolKey, deletedReviewJobs: result.deletedReviewJobs });
}

async function deleteEdpIssue(request: Request, env: Env, userId: string, encodedKey: string): Promise<Response> {
  if (request.method !== "DELETE") return methodNotAllowed(["DELETE"]);
  const schoolKey = decodedSchoolKey(encodedKey);
  const expected = expectedVersion(await deleteBody(request));
  const result = await env.DB.prepare(`DELETE FROM edp_issues
    WHERE user_id = ? AND school_key = ? AND submitted_at = ? AND submission_id = ?`)
    .bind(userId, schoolKey, expected.submittedAt, expected.submissionId).run();
  if ((result.meta.changes ?? 0) !== 1) throw new ApiError(409, "edp_issue_changed", "问题记录已变化；请刷新后重新确认删除。" );
  return json({ ok: true, deleted: true, schoolKey });
}

function fankeSubmissionId(value: string): string {
  return value.startsWith("fanke-") ? value : `fanke-${value}`;
}

function trustedFankeUrl(value: string, base?: string): URL | null {
  try {
    const url = new URL(value.replace(/&amp;/gu, "&"), base);
    const host = url.hostname.toLocaleLowerCase("en-US");
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (!/^download\.s\d+i\.co99\.net$/u.test(host)
      && !/(?:^|\.)faiusr\.com$/u.test(host)
      && !/(?:^|\.)fkw\.com$/u.test(host)) return null;
    return url;
  } catch {
    return null;
  }
}

async function fetchTrustedFankeFile(url: URL): Promise<Response> {
  let current = url;
  for (let redirect = 0; redirect <= 4; redirect += 1) {
    const response = await fetch(current, { redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("Location");
    const next = location ? trustedFankeUrl(location, current.href) : null;
    await response.body?.cancel("following validated Fanke redirect").catch(() => undefined);
    if (!next) throw new Error("凡科文件跳转到了不受信任的地址，已停止下载。" );
    current = next;
  }
  throw new Error("凡科文件下载跳转次数过多，将稍后重试。" );
}

function decodeFankeHtml(value: string): string {
  return value
    .replace(/&amp;/giu, "&")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">");
}

function fankeContentDispositionFilename(value: string | null): string | null {
  if (!value) return null;
  const encoded = value.match(/filename\*\s*=\s*UTF-8''([^;]+)/iu)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded.trim().replace(/^"|"$/gu, "")); } catch { /* Use the plain filename form below. */ }
  }
  return value.match(/filename\s*=\s*"([^"]+)"/iu)?.[1]
    ?? value.match(/filename\s*=\s*([^;\s]+)/iu)?.[1]
    ?? null;
}

function fankeSizeBytes(value: string, unit: string): number | null {
  const amount = Number(value);
  const multiplier = unit.toLocaleUpperCase("en-US") === "GB" ? 1024 ** 3
    : unit.toLocaleUpperCase("en-US") === "MB" ? 1024 ** 2
      : unit.toLocaleUpperCase("en-US") === "KB" ? 1024 : 1;
  const bytes = Math.ceil(amount * multiplier);
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
}

async function resolveFankeViewLink(file: FankeQueueFile): Promise<{ url: URL; filename: string; size: number | null }> {
  const initial = trustedFankeUrl(file.downloadUrl);
  if (!initial) throw new Error("凡科文件地址不受信任，已停止下载。" );
  if (!/\/view\.jsp$/iu.test(initial.pathname) || !initial.searchParams.get("fileID")) {
    return { url: initial, filename: file.filename, size: file.size };
  }
  const viewResponse = await fetchTrustedFankeFile(initial);
  if (!viewResponse.ok) throw new Error(`凡科文件信息页读取失败（HTTP ${viewResponse.status}），将稍后重试。`);
  const declared = Number(viewResponse.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > 1024 * 1024) {
    await viewResponse.body?.cancel("unexpectedly large Fanke view page").catch(() => undefined);
    throw new Error("凡科文件信息页内容异常，已停止下载。" );
  }
  const html = decodeFankeHtml(await viewResponse.text());
  if (html.length > 1024 * 1024) throw new Error("凡科文件信息页内容异常，已停止下载。" );
  const hrefs = [...html.matchAll(/href\s*=\s*(?:"([^"]+)"|'([^']+)')/giu)].map((match) => match[1] || match[2]);
  const direct = hrefs.map((href) => trustedFankeUrl(href, initial.href)).find((url) => url && /^download\.s\d+i\.co99\.net$/u.test(url.hostname));
  if (!direct) throw new Error("凡科文件信息页没有找到可下载的原始附件，将稍后重试。" );
  const htmlName = html.match(/文件名称\s*[:：]\s*([^<\r\n]+)/u)?.[1]?.trim();
  const queryName = direct.searchParams.get("f") ?? direct.searchParams.get("filename") ?? direct.searchParams.get("name");
  const filename = (queryName || htmlName || file.filename).normalize("NFKC").trim();
  const sizeMatch = html.match(/文件大小\s*[:：]\s*([0-9.]+)\s*(GB|MB|KB|B)/iu);
  return { url: direct, filename, size: sizeMatch ? fankeSizeBytes(sizeMatch[1], sizeMatch[2]) : file.size };
}

async function registrationWorkbookFromFankeZip(bytes: ArrayBuffer): Promise<{ bytes: Uint8Array; filename: string } | null> {
  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(bytes, { checkCRC32: true });
  } catch {
    return null;
  }
  const workbooks = Object.values(archive.files).filter((entry) => {
    if (entry.dir || !/\.xlsx$/iu.test(entry.name)) return false;
    const parts = entry.name.replace(/\\/gu, "/").split("/").filter(Boolean);
    const basename = parts.at(-1)?.toLocaleLowerCase("en-US") ?? "";
    return !parts.some((part) => part.toLocaleLowerCase("en-US") === "__macosx")
      && !basename.startsWith("._")
      && basename !== ".ds_store";
  });
  if (workbooks.length !== 1) return null;
  const workbook = await workbooks[0].async("uint8array");
  if (workbook.byteLength < 1 || workbook.byteLength > MAX_UPLOAD_BYTES) return null;
  return { bytes: workbook, filename: workbooks[0].name.replace(/\\/gu, "/").split("/").at(-1) || "报名表.xlsx" };
}

async function fankeResult(response: Response, kind: FankeFileKind): Promise<FankeProcessResult> {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = await response.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
  } catch {
    // The HTTP status remains authoritative when an upstream error has no JSON body.
  }
  const error = payload.error && typeof payload.error === "object" && !Array.isArray(payload.error)
    ? payload.error as Record<string, unknown>
    : null;
  const code = typeof error?.code === "string" ? error.code : null;
  const message = typeof error?.message === "string"
    ? error.message
    : typeof payload.message === "string" ? payload.message : undefined;
  if (response.status === 422 && code === "before_collection_start") return { status: "ignored", message };
  if (!response.ok || payload.ok === false) {
    if (response.status >= 500 || response.status === 408 || response.status === 429) {
      throw new Error(message || "服务器暂时无法处理凡科文件。" );
    }
    return { status: "invalid", message: message || "文件格式或字段不符合当前栏目的收集规则。" };
  }
  const masterSync = payload.masterSync && typeof payload.masterSync === "object" && !Array.isArray(payload.masterSync)
    ? payload.masterSync as Record<string, unknown>
    : null;
  if (kind === "registration" && masterSync?.status === "failed") {
    return {
      status: "invalid",
      message: typeof masterSync.message === "string" ? masterSync.message : "报名表已保存，但唯一统计表未能更新，请人工核对。",
    };
  }
  if (kind === "edp" && payload.qualified === false) {
    return { status: "invalid", message: message || "EDP 文件数量或格式未通过检查。" };
  }
  return { status: "processed", message };
}

async function processFankeFile(env: Env, userId: string, file: FankeQueueFile) {
  const categorySettings = file.kind === "registration"
    ? await getSettings(env.DB, userId)
    : file.kind === "edp"
      ? await getEdpSettings(env.DB, userId)
      : await getMediaSettings(env.DB, userId, file.kind);
  try {
    enforceCollectionStart(categorySettings, file.submittedAt, file.kind === "registration"
      ? "报名表"
      : file.kind === "edp"
        ? "EDP"
        : file.kind === "poster" ? "海报" : "视频");
  } catch (error) {
    if (error instanceof ApiError && error.code === "before_collection_start") {
      return { status: "ignored" as const, message: error.message };
    }
    throw error;
  }
  const resolved = await resolveFankeViewLink(file);
  let filename = resolved.filename;
  let kind = classifyFankeFile(filename) ?? file.kind;
  let maximum = kind === "poster" || kind === "video" ? 200 * 1024 * 1024 : MAX_UPLOAD_BYTES;
  if (resolved.size !== null && (resolved.size < 1 || resolved.size > maximum)) {
    return { status: "invalid" as const, message: `文件大小不符合限制（当前栏目上限 ${maximum / 1024 / 1024}MB）。` };
  }
  let downloaded: Response;
  try {
    downloaded = await fetchTrustedFankeFile(resolved.url);
  } catch {
    throw new Error("无法从凡科下载文件；下载地址可能已过期或发生重定向，将稍后重试。" );
  }
  if (!downloaded.ok || !downloaded.body) {
    throw new Error(`凡科文件下载失败（HTTP ${downloaded.status}），将稍后重试。`);
  }
  filename = fankeContentDispositionFilename(downloaded.headers.get("Content-Disposition")) || filename;
  kind = classifyFankeFile(filename) ?? kind;
  maximum = kind === "poster" || kind === "video" ? 200 * 1024 * 1024 : MAX_UPLOAD_BYTES;
  const rawDeclaredSize = downloaded.headers.get("Content-Length") ?? (resolved.size === null ? null : String(resolved.size));
  const declaredSize = rawDeclaredSize === null ? Number.NaN : Number(rawDeclaredSize);
  if (Number.isFinite(declaredSize) && (declaredSize < 1 || declaredSize > maximum)) {
    await downloaded.body.cancel("file size outside limit");
    return { status: "invalid" as const, message: `文件大小不符合限制（当前栏目上限 ${maximum / 1024 / 1024}MB）。` };
  }
  const submissionId = fankeSubmissionId(file.submissionId);
  if (kind === "registration" || kind === "edp") {
    let bytes: ArrayBuffer | Uint8Array = await downloaded.arrayBuffer();
    if (bytes.byteLength < 1 || bytes.byteLength > maximum) {
      return { status: "invalid" as const, message: `文件大小不符合限制（当前栏目上限 ${maximum / 1024 / 1024}MB）。` };
    }
    if (kind === "registration" && /\.zip$/iu.test(filename)) {
      const extracted = await registrationWorkbookFromFankeZip(bytes);
      if (!extracted) {
        return { status: "invalid" as const, message: "报名表 ZIP 中必须且只能包含一份有效的 .xlsx 报名表。" };
      }
      bytes = extracted.bytes;
      filename = extracted.filename;
    }
    const form = new FormData();
    form.set("schoolName", file.schoolName);
    form.set("submittedAt", file.submittedAt);
    form.set("submissionId", submissionId);
    form.set("file", new File([bytes instanceof Uint8Array ? new Uint8Array(bytes) : bytes], filename, { type: kind === "registration" ? XLSX_CONTENT_TYPE : "application/octet-stream" }));
    const internal = new Request(`https://collector.internal/api/${kind === "registration" ? "registrations" : "edp-submissions"}`, {
      method: "POST",
      body: form,
    });
    return fankeResult(
      kind === "registration"
        ? await uploadRegistration(internal, env, userId)
        : await uploadEdpSubmission(internal, env, userId, { skipCollectionStart: true }),
      kind,
    );
  }

  if (!Number.isSafeInteger(declaredSize) || declaredSize < 1) {
    await downloaded.body.cancel("missing content length");
    throw new Error("凡科下载响应未提供文件大小，无法安全写入大文件存储，将稍后重试。" );
  }
  const url = new URL(`https://collector.internal/api/media/${kind}`);
  url.searchParams.set("schoolName", file.schoolName);
  url.searchParams.set("submittedAt", file.submittedAt);
  url.searchParams.set("submissionId", submissionId);
  const headers = new Headers({
    "Content-Type": "application/octet-stream",
    "Content-Length": String(declaredSize),
    "X-File-Name": encodeURIComponent(filename),
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
  });
  const internal = new Request(url, { method: "POST", headers, body: downloaded.body });
  return fankeResult(await uploadMediaAsset(internal, env, userId, kind, { skipCollectionStart: true }), kind);
}

function authNotConfigured(extraHeaders?: HeadersInit): Response {
  return authJson({
    ok: false,
    authenticated: false,
    configured: false,
    error: { code: "auth_not_configured", message: "独立密码登录尚未安全配置。" },
  }, 503, extraHeaders);
}

async function authStatus(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET") return authMethodNotAllowed(["GET"]);
  const config = await getAuthConfig(env, url);
  const founderManagementEnabled = Boolean(getFounderPasswordHash(env, url));
  if (!config.configured || !config.sessionSecret) {
    return authJson({ ok: true, authenticated: false, configured: false, founderManagementEnabled }, 503);
  }
  const payload = await verifySessionToken(readCookie(request, cookieName(url)), config.sessionSecret);
  const authenticated = Boolean(payload && payload.pv === config.passwordVersion);
  return authJson({
    ok: true,
    authenticated,
    configured: true,
    founderManagementEnabled,
    ...(authenticated && payload ? {
      expiresAt: new Date(payload.exp * 1000).toISOString(),
      passwordVersion: config.passwordVersion,
    } : {}),
  });
}

async function readLoginPassword(request: Request): Promise<string> {
  if (!request.headers.get("Content-Type")?.toLowerCase().includes("application/json")) {
    throw new ApiError(415, "unsupported_media_type", "登录信息必须以 JSON 格式提交。");
  }
  const declaredLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_LOGIN_BODY_BYTES) {
    throw new ApiError(413, "login_body_too_large", "登录请求内容过大。");
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_LOGIN_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The size limit has already been enforced; transport cancellation is best effort.
        }
        throw new ApiError(413, "login_body_too_large", "登录请求内容过大。");
      }
      chunks.push(value);
    }
  }
  const bodyBytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let rawBody: string;
  try {
    rawBody = new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes);
  } catch {
    throw new ApiError(400, "invalid_json", "登录信息不是有效的 JSON。");
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new ApiError(400, "invalid_json", "登录信息不是有效的 JSON。");
  }
  if (!isPlainObject(body) || typeof body.password !== "string") {
    throw new ApiError(400, "password_required", "请输入访问密码。");
  }
  if (!body.password || body.password.length > 1024 || new TextEncoder().encode(body.password).length > 4096) {
    throw new ApiError(400, "invalid_password", "访问密码格式不正确。");
  }
  return body.password;
}

interface FounderPasswordChange {
  founderPassword: string;
  newPassword: string;
}

function passwordPolicy() {
  return {
    minLength: NEW_PASSWORD_MIN_LENGTH,
    maxLength: NEW_PASSWORD_MAX_LENGTH,
    requiresCharacterTypes: 2,
  };
}

function validateNewPassword(password: string): void {
  const length = Array.from(password).length;
  const byteLength = new TextEncoder().encode(password).length;
  const characterTypes = [
    /\p{L}/u.test(password),
    /\p{N}/u.test(password),
    /[^\p{L}\p{N}\s]/u.test(password),
  ].filter(Boolean).length;
  const containsControlCharacter = Array.from(password).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  if (
    length < NEW_PASSWORD_MIN_LENGTH || length > NEW_PASSWORD_MAX_LENGTH || byteLength > 512 ||
    password !== password.trim() || containsControlCharacter || characterTypes < 2
  ) {
    throw new ApiError(
      400,
      "new_password_policy_failed",
      `新密码须为 ${NEW_PASSWORD_MIN_LENGTH}–${NEW_PASSWORD_MAX_LENGTH} 个字符，且至少包含字母、数字、符号中的两类。`,
    );
  }
}

async function readFounderPasswordChange(request: Request): Promise<FounderPasswordChange> {
  if (!request.headers.get("Content-Type")?.toLowerCase().includes("application/json")) {
    throw new ApiError(415, "unsupported_media_type", "创始人密码修改信息必须以 JSON 格式提交。");
  }
  const declaredLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_FOUNDER_BODY_BYTES) {
    throw new ApiError(413, "founder_body_too_large", "密码修改请求内容过大。");
  }

  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_FOUNDER_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The byte limit is already enforced; transport cancellation is best effort.
        }
        throw new ApiError(413, "founder_body_too_large", "密码修改请求内容过大。");
      }
      chunks.push(value);
    }
  }

  const bodyBytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes));
  } catch {
    throw new ApiError(400, "invalid_json", "密码修改信息不是有效的 JSON。");
  }
  if (!isPlainObject(body) || typeof body.founderPassword !== "string" || typeof body.newPassword !== "string") {
    throw new ApiError(400, "password_fields_required", "请输入创始人密码和新共享密码。");
  }
  if (
    !body.founderPassword || body.founderPassword.length > 1024 ||
    new TextEncoder().encode(body.founderPassword).length > 4096
  ) {
    throw new ApiError(400, "invalid_founder_password", "创始人密码格式不正确。");
  }
  validateNewPassword(body.newPassword);
  if (body.newPassword === body.founderPassword) {
    throw new ApiError(400, "new_password_matches_founder", "新共享密码不能与创始人密码相同。");
  }
  return { founderPassword: body.founderPassword, newPassword: body.newPassword };
}

async function authLogin(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "POST") return authMethodNotAllowed(["POST"]);
  const config = await getAuthConfig(env, url);
  if (!config.configured || !config.passwordHash || !config.sessionSecret) return authNotConfigured();
  await ensureSchema(env.DB);

  const password = await readLoginPassword(request);
  if (await passwordMatches(password, config.passwordHash)) {
    const session = await createSessionToken(config.sessionSecret, config.passwordVersion);
    return authJson({
      ok: true,
      authenticated: true,
      configured: true,
      passwordVersion: config.passwordVersion,
      expiresAt: session.expiresAt,
    }, 200, { "Set-Cookie": sessionCookie(url, session.token, SESSION_TTL_SECONDS) });
  }

  return authJson({
    ok: false,
    authenticated: false,
    configured: true,
    error: { code: "invalid_credentials", message: "访问密码不正确。" },
  }, 401);
}

async function authLogout(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "POST") return authMethodNotAllowed(["POST"]);
  const headers = { "Set-Cookie": sessionCookie(url, "", 0) };
  const config = await getAuthConfig(env, url);
  if (!config.configured) return authNotConfigured(headers);
  return authJson({ ok: true, authenticated: false, configured: true }, 200, headers);
}

async function changeFounderManagedPassword(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "POST") return authMethodNotAllowed(["POST"]);
  const config = await getAuthConfig(env, url);
  if (!config.configured || !config.passwordHash || !config.sessionSecret) return authNotConfigured();

  const founderPasswordHash = getFounderPasswordHash(env, url);
  if (!founderPasswordHash) {
    return authJson({
      ok: false,
      authenticated: true,
      configured: true,
      founderManagementEnabled: false,
      error: {
        code: "founder_management_disabled",
        message: "创始人密码管理尚未安全配置，请先配置 APP_FOUNDER_PASSWORD_HASH。",
      },
    }, 503);
  }

  const input = await readFounderPasswordChange(request);
  if (!(await passwordMatches(input.founderPassword, founderPasswordHash))) {
    return authJson({
      ok: false,
      authenticated: true,
      configured: true,
      error: { code: "invalid_founder_credentials", message: "创始人密码不正确。" },
    }, 401);
  }

  if (await passwordMatches(input.newPassword, config.passwordHash)) {
    return authJson({
      ok: false,
      authenticated: true,
      configured: true,
      passwordPolicy: passwordPolicy(),
      error: { code: "new_password_unchanged", message: "新共享密码不能与当前共享密码相同。" },
    }, 400);
  }

  const sharedPasswordHash = await createPasswordHash(input.newPassword);
  const updatedAt = new Date().toISOString();
  const nextPasswordVersion = config.passwordVersion + 1;
  const updated = await env.DB.prepare(`
    INSERT INTO app_security_settings (
      singleton_id, shared_password_hash, password_version, updated_at
    ) VALUES (1, ?1, ?2, ?3)
    ON CONFLICT(singleton_id) DO UPDATE SET
      shared_password_hash = excluded.shared_password_hash,
      password_version = excluded.password_version,
      updated_at = excluded.updated_at
    WHERE app_security_settings.password_version = ?4
    RETURNING password_version
  `).bind(sharedPasswordHash, nextPasswordVersion, updatedAt, config.passwordVersion)
    .first<{ password_version: number }>();
  if (!updated || updated.password_version !== nextPasswordVersion) {
    return authJson({
      ok: false,
      authenticated: false,
      configured: true,
      error: {
        code: "password_changed_concurrently",
        message: "共享密码已在另一窗口中更新，请重新登录后再试。",
      },
    }, 409, { "Set-Cookie": sessionCookie(url, "", 0) });
  }

  const session = await createSessionToken(config.sessionSecret, nextPasswordVersion);
  return authJson({
    ok: true,
    changed: true,
    authenticated: true,
    configured: true,
    founderManagementEnabled: true,
    passwordVersion: nextPasswordVersion,
    expiresAt: session.expiresAt,
    passwordPolicy: passwordPolicy(),
    message: "共享登录密码已更新；其他设备的旧登录状态已失效。",
  }, 200, { "Set-Cookie": sessionCookie(url, session.token, SESSION_TTL_SECONDS) });
}

async function requireBusinessSession(request: Request, env: Env, url: URL): Promise<void> {
  // Reject absent or forged cookies before touching D1. A valid signature is only a
  // preflight; the authoritative password version is still read below.
  const sessionSecret = getSessionSecret(env, url);
  if (!sessionSecret) {
    throw new ApiError(503, "auth_not_configured", "独立密码登录尚未安全配置。");
  }
  const provisionalSession = await verifySessionToken(readCookie(request, cookieName(url)), sessionSecret);
  if (!provisionalSession) {
    throw new ApiError(401, "authentication_required", "请先输入访问密码后再使用采集功能。");
  }

  const config = await getAuthConfig(env, url);
  if (!config.configured || !config.sessionSecret) {
    throw new ApiError(503, "auth_not_configured", "独立密码登录尚未安全配置。");
  }
  if (provisionalSession.pv !== config.passwordVersion) {
    throw new ApiError(401, "authentication_required", "登录状态已失效，请重新输入访问密码。");
  }
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const fankeWebhook = url.pathname.match(/^\/api\/fanke\/webhook\/([A-Za-z0-9_-]{40,80})$/u);
  if (fankeWebhook) return handleFankeWebhook(request, env, fankeWebhook[1]);

  requireSameOrigin(request, url);

  if (url.pathname === "/api/auth/status") return authStatus(request, env, url);
  if (url.pathname === "/api/auth/login") return authLogin(request, env, url);
  if (url.pathname === "/api/auth/logout") return authLogout(request, env, url);
  if (url.pathname.startsWith("/api/auth/")) {
    return authJson({ ok: false, authenticated: false, error: { code: "api_not_found", message: "未找到该接口。" } }, 404);
  }

  await requireBusinessSession(request, env, url);
  await ensureSchema(env.DB);
  const userId = SHARED_USER_ID;

  const certificateTemplateResponse = await handleCertificateTemplateApi(request, env, userId, url);
  if (certificateTemplateResponse) return certificateTemplateResponse;
  const edpReviewResponse = await handleEdpReviewApi(request, env, userId, url);
  if (edpReviewResponse) return edpReviewResponse;
  const edpRuleDocumentResponse = await handleEdpRuleDocumentApi(request, env, userId, url);
  if (edpRuleDocumentResponse) return edpRuleDocumentResponse;

  if (url.pathname === "/api/founder/password") return changeFounderManagedPassword(request, env, url);
  if (url.pathname === "/api/fanke/assistant/start") return startFankeAssistantScan(request, env, userId);
  if (url.pathname === "/api/fanke/assistant/ingest") return ingestFankeAssistantBatch(request, env, userId);
  if (url.pathname === "/api/fanke/assistant/finish") return finishFankeAssistantScan(request, env, userId);
  if (url.pathname === "/api/fanke/connector") return configureFankeConnector(request, env, userId);
  const fankeCollect = url.pathname.match(/^\/api\/fanke\/collect\/(registration|edp|poster|video)$/u);
  if (fankeCollect) {
    return collectFankeNow(
      request,
      env,
      userId,
      fankeCollect[1] as FankeFileKind,
      (file) => processFankeFile(env, userId, file),
    );
  }
  const fankeProblems = url.pathname.match(/^\/api\/fanke\/problems\/(registration|edp|poster|video)$/u);
  if (fankeProblems) {
    return clearFankeProblems(request, env, userId, fankeProblems[1] as FankeFileKind);
  }
  if (url.pathname === "/api/dashboard") return dashboard(request, env, userId);
  if (url.pathname === "/api/settings") return updateSettings(request, env, userId);
  if (url.pathname === "/api/registration-receipt-settings") return updateRegistrationReceiptSettings(request, env, userId);
  if (url.pathname === "/api/edp-receipt-settings") return updateEdpReceiptSettings(request, env, userId);
  if (url.pathname === "/api/edp-settings") return updateEdpSettings(request, env, userId);
  const mediaSettingsRoute = url.pathname.match(/^\/api\/media-settings\/(poster|video)$/);
  if (mediaSettingsRoute && isMediaAssetKind(mediaSettingsRoute[1])) {
    return updateMediaSettings(request, env, userId, mediaSettingsRoute[1]);
  }
  if (url.pathname === "/api/master") {
    return request.method === "DELETE" ? deleteMaster(request, env, userId) : uploadMaster(request, env, userId);
  }
  if (url.pathname === "/api/master/download") return downloadMaster(request, env, userId);
  if (url.pathname === "/api/registrations") return uploadRegistration(request, env, userId);
  if (url.pathname === "/api/edp-submissions") return uploadEdpSubmission(request, env, userId);
  if (url.pathname === "/api/mail-settings") return updateMailSettings(request, env, userId);
  if (url.pathname === "/api/mail-test") return testMailSettings(request, env, userId);
  if (url.pathname === "/api/mail-sync") return syncMailNow(request, env, userId);
  if (url.pathname === "/api/mail-messages") return listMailMessagesPage(request, env, userId);
  if (url.pathname === "/api/mail-media-candidates") return listMailMediaCandidates(request, env, userId);
  if (url.pathname === "/api/mail-browser/scans/start") return startBrowserMailScan(request, env, userId);
  if (url.pathname === "/api/mail-browser/scans/batch") return ingestBrowserMailBatch(request, env, userId);
  if (url.pathname === "/api/mail-browser/scans/finish") return finishBrowserMailScan(request, env, userId);
  if (url.pathname === "/api/mail-browser/assets/exists") return browserMailAssetsExist(request, env, userId);
  if (url.pathname === "/api/mail-browser/state") return getBrowserMailScanState(request, env, userId);

  const mailMediaAssign = url.pathname.match(/^\/api\/mail-media-candidates\/([a-fA-F0-9]{64})\/assign$/);
  if (mailMediaAssign) {
    return assignMailMediaCandidate(request, env, userId, mailMediaAssign[1]);
  }

  const mediaMultipartCreate = url.pathname.match(/^\/api\/media\/(poster|video)\/multipart\/create$/);
  if (mediaMultipartCreate && isMediaAssetKind(mediaMultipartCreate[1])) {
    return createMediaMultipartUpload(request, env, userId, mediaMultipartCreate[1]);
  }
  const mediaMultipartPart = url.pathname.match(/^\/api\/media\/(poster|video)\/multipart\/([^/]+)\/parts\/(\d+)$/);
  if (mediaMultipartPart && isMediaAssetKind(mediaMultipartPart[1])) {
    return uploadMediaMultipartPart(request, env, userId, mediaMultipartPart[1], mediaMultipartPart[2], mediaMultipartPart[3]);
  }
  const mediaMultipartComplete = url.pathname.match(/^\/api\/media\/(poster|video)\/multipart\/([^/]+)\/complete$/);
  if (mediaMultipartComplete && isMediaAssetKind(mediaMultipartComplete[1])) {
    return completeMediaMultipartUpload(request, env, userId, mediaMultipartComplete[1], mediaMultipartComplete[2]);
  }
  const mediaMultipartAbort = url.pathname.match(/^\/api\/media\/(poster|video)\/multipart\/([^/]+)$/);
  if (mediaMultipartAbort && isMediaAssetKind(mediaMultipartAbort[1])) {
    return abortMediaMultipartUpload(request, env, userId, mediaMultipartAbort[1], mediaMultipartAbort[2]);
  }
  const mediaUpload = url.pathname.match(/^\/api\/media\/(poster|video)$/);
  if (mediaUpload && isMediaAssetKind(mediaUpload[1])) {
    return uploadMediaAsset(request, env, userId, mediaUpload[1]);
  }

  const registrationReceipt = url.pathname.match(/^\/api\/registrations\/([^/]+)\/receipt$/);
  if (registrationReceipt) return refreshRegistrationReceipt(request, env, userId, registrationReceipt[1]);
  const registrationDownload = url.pathname.match(/^\/api\/registrations\/([^/]+)\/download$/);
  if (registrationDownload) return downloadRegistration(request, env, userId, registrationDownload[1]);
  const registrationDelete = url.pathname.match(/^\/api\/registrations\/([^/]+)$/);
  if (registrationDelete) return deleteRegistration(request, env, userId, registrationDelete[1]);
  const edpDownload = url.pathname.match(/^\/api\/edp-submissions\/([^/]+)\/download$/);
  if (edpDownload) return downloadEdpSubmission(request, env, userId, edpDownload[1]);
  const edpDelete = url.pathname.match(/^\/api\/edp-submissions\/([^/]+)$/);
  if (edpDelete) return deleteEdpSubmission(request, env, userId, edpDelete[1]);
  const edpIssueDelete = url.pathname.match(/^\/api\/edp-issues\/([^/]+)$/);
  if (edpIssueDelete) return deleteEdpIssue(request, env, userId, edpIssueDelete[1]);
  const mediaDownload = url.pathname.match(/^\/api\/media\/(poster|video)\/([^/]+)\/download$/);
  if (mediaDownload && isMediaAssetKind(mediaDownload[1])) {
    return downloadMediaAsset(request, env, userId, mediaDownload[1], mediaDownload[2]);
  }
  const mediaDelete = url.pathname.match(/^\/api\/media\/(poster|video)\/([^/]+)$/);
  if (mediaDelete && isMediaAssetKind(mediaDelete[1])) {
    return deleteMediaAsset(request, env, userId, mediaDelete[1], mediaDelete[2]);
  }
  const mailAttachmentDownload = url.pathname.match(/^\/api\/mail-attachments\/([^/]+)\/([^/]+)\/(\d+)\/(\d+)\/download$/);
  if (mailAttachmentDownload) {
    return downloadMailAttachment(
      request,
      env,
      userId,
      mailAttachmentDownload[1],
      mailAttachmentDownload[2],
      mailAttachmentDownload[3],
      mailAttachmentDownload[4],
    );
  }
  const mailAttachmentDelete = url.pathname.match(/^\/api\/mail-attachments\/([^/]+)\/([^/]+)\/(\d+)\/(\d+)$/);
  if (mailAttachmentDelete) {
    return deleteMailAttachment(
      request,
      env,
      userId,
      mailAttachmentDelete[1],
      mailAttachmentDelete[2],
      mailAttachmentDelete[3],
      mailAttachmentDelete[4],
    );
  }
  const rawMailDownload = url.pathname.match(/^\/api\/mail-messages\/([^/]+)\/([^/]+)\/(\d+)\/download$/);
  if (rawMailDownload) {
    return downloadRawMail(request, env, userId, rawMailDownload[1], rawMailDownload[2], rawMailDownload[3]);
  }
  return apiError(404, "api_not_found", "未找到该接口。");
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url);
      } catch (error) {
        let response: Response;
        if (error instanceof ApiError) {
          response = apiError(error.status, error.code, error.message);
        } else {
          console.error("Registration collector API failed", error);
          response = apiError(500, "internal_error", "服务器暂时无法完成请求，请稍后重试。");
        }
        if (url.pathname.startsWith("/api/auth/") || url.pathname.startsWith("/api/founder/")) {
          response.headers.set("Vary", "Cookie");
        }
        return response;
      }
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    const response = await handler.fetch(request, env, ctx);
    if (!response.headers.get("Content-Type")?.toLowerCase().includes("text/html")) return response;
    const headers = new Headers(response.headers);
    headers.set("Content-Security-Policy", "frame-ancestors 'none'");
    headers.set("X-Frame-Options", "DENY");
    headers.set("Referrer-Policy", "same-origin");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    await ensureSchema(env.DB);
    const results = await Promise.allSettled([
      runDueMailCollectors(env),
      runDueFankeCollectors(env, SHARED_USER_ID, (file) => processFankeFile(env, SHARED_USER_ID, file)),
    ]);
    for (const result of results) {
      if (result.status === "rejected") console.error("Scheduled collector failed", result.reason);
    }
    await processNextEdpReview(env, SHARED_USER_ID);
  },
};

export default worker;
