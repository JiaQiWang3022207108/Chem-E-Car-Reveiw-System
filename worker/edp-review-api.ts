import JSZip from "jszip";
import {
  auditEdpArchive,
  computeOverallReviewStatus,
  EDP_AUDIT_RULE_IDS,
  type EdpAuditItem,
  type AnnualRuleFactForReview,
  type EdpOverallReviewStatus,
  type EdpSubmissionRound,
} from "./edp-review-engine";
import {
  EDP_REVIEW_RULES,
  EDP_REVIEW_RULE_VERSION,
  type EdpReviewEvidence,
  type EdpReviewStatus,
} from "./edp-review-rules";
import { buildEdpReviewWorkbook } from "./edp-review-workbook";
import { assessRegistrationWorkbook } from "./registration-workbook";

export const EDP_REVIEW_TEMPLATE_VERSION = "v1";
export const FIXED_EDP_REVIEW_PERSONNEL = Object.freeze({
  safetyReviewerName: "潘芳丽",
  safetyReviewerEmail: "service@chemecar.cn",
  expertMemberName: "华炜",
});

export interface EdpReviewApiEnv {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS?: Fetcher;
}

export interface EdpReviewSourceSubmission {
  schoolKey: string;
  schoolName: string;
  submissionId: string;
  submittedAt: string;
  submissionRound: EdpSubmissionRound;
  sourceR2Key: string;
  sourceFilename: string;
}

interface ReviewSettingsRow {
  competition_year: string;
  safety_reviewer_name: string;
  safety_reviewer_email: string;
  expert_member_name: string;
  expert_member_email: string;
  template_version: string;
  active_rule_document_id: string | null;
  active_rule_version: string | null;
  updated_at: string;
}

interface AnnualRuleFactRow {
  fact_id: string;
  category: string;
  normalized_requirement: string;
  operator: AnnualRuleFactForReview["operator"];
  structured_value: string | null;
  structured_unit: string | null;
  source_page: number;
  evidence_excerpt: string;
  confidence: AnnualRuleFactForReview["confidence"];
  confirmation_status: AnnualRuleFactForReview["confirmationStatus"];
}

interface ReviewJobRow {
  job_id: string;
  school_key: string;
  school_name: string;
  submission_id: string;
  submitted_at: string;
  submission_round: number;
  source_r2_key: string | null;
  source_filename: string | null;
  work_name: string | null;
  instructor_name: string | null;
  instructor_email: string | null;
  archive_format?: "zip" | "7z" | "rar" | null;
  submission_round_source?: "captured" | "legacy_unknown" | "inferred_file_count" | "inferred_current_setting" | null;
  rule_version: string;
  template_version: string;
  status: "queued" | "processing" | "needs_human" | "ready" | "completed" | "failed" | "superseded";
  overall_status: "pending" | EdpOverallReviewStatus;
  superseded_by: string | null;
  last_error: string | null;
  reviewed_at: string | null;
  finalized_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ReviewItemRow {
  rule_id: string;
  worksheet_name: string;
  template_row: number;
  automatic_status: EdpReviewStatus;
  final_status: EdpReviewStatus;
  suggested_comment: string | null;
  final_comment: string | null;
  evidence_json: string;
  document_name: string | null;
  page_number: number | null;
  is_blocking: number;
  rule_source: string;
  override_actor: string | null;
  override_previous_status: EdpReviewStatus | null;
  overridden_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ReviewExportRow {
  export_type: "draft" | "final";
  r2_key: string;
  filename: string;
  size: number;
  rule_version: string;
  template_version: string;
  submission_id: string;
  generated_at: string;
  created_at: string;
}

class EdpReviewApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EdpReviewApiError";
  }
}

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  responseHeaders.set("Cache-Control", "no-store");
  responseHeaders.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(data), { status, headers: responseHeaders });
}

function methodNotAllowed(allowed: string[]): Response {
  return json({ ok: false, error: { code: "method_not_allowed", message: `此接口仅支持 ${allowed.join("、")} 请求。` } }, 405, {
    Allow: allowed.join(", "),
  });
}

function apiError(error: unknown): Response {
  if (error instanceof EdpReviewApiError) {
    return json({ ok: false, error: { code: error.code, message: error.message } }, error.status);
  }
  console.error("EDP review API failed", error);
  return json({ ok: false, error: { code: "edp_review_failed", message: "EDP 审核暂时无法完成，请稍后重试。" } }, 500);
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("Content-Type")?.toLocaleLowerCase("en-US").includes("application/json")) {
    throw new EdpReviewApiError(415, "unsupported_media_type", "请以 JSON 格式提交审核设置或人工结论。");
  }
  const declaredLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > 16 * 1024) {
    throw new EdpReviewApiError(413, "request_too_large", "审核设置内容过大。");
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new EdpReviewApiError(400, "invalid_json", "提交内容不是有效的 JSON。");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new EdpReviewApiError(400, "invalid_body", "提交内容必须是一个对象。");
  }
  return body as Record<string, unknown>;
}

function textField(body: Record<string, unknown>, key: string, maximum: number): string {
  const value = body[key];
  if (typeof value !== "string") throw new EdpReviewApiError(400, "invalid_field", `${key} 必须是文本。`);
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length > maximum) throw new EdpReviewApiError(400, "invalid_field", `${key} 内容过长。`);
  return normalized;
}

function settingsFromRow(row: ReviewSettingsRow | null) {
  return {
    competitionYear: row?.competition_year ?? "",
    ...FIXED_EDP_REVIEW_PERSONNEL,
    expertMemberEmail: "",
    templateVersion: row?.template_version ?? EDP_REVIEW_TEMPLATE_VERSION,
    activeRuleDocumentId: row?.active_rule_document_id ?? null,
    activeRuleVersion: row?.active_rule_version ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

function jobFromRow(row: ReviewJobRow) {
  return {
    jobId: row.job_id,
    schoolKey: row.school_key,
    schoolName: row.school_name,
    submissionId: row.submission_id,
    submittedAt: row.submitted_at,
    submissionRound: row.submission_round,
    submissionRoundSource: row.submission_round_source ?? null,
    archiveFormat: row.archive_format ?? null,
    sourceFilename: row.source_filename,
    workName: row.work_name,
    instructorName: row.instructor_name,
    instructorEmail: row.instructor_email,
    ruleVersion: row.rule_version,
    templateVersion: row.template_version,
    status: row.status,
    overallStatus: row.overall_status,
    supersededBy: row.superseded_by,
    lastError: row.last_error,
    reviewedAt: row.reviewed_at,
    finalizedAt: row.finalized_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseEvidence(value: string): EdpReviewEvidence[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as EdpReviewEvidence[] : [];
  } catch {
    return [];
  }
}

function itemFromRow(row: ReviewItemRow) {
  return {
    ruleId: row.rule_id,
    worksheetName: row.worksheet_name,
    templateRow: row.template_row,
    automaticStatus: row.automatic_status,
    finalStatus: row.final_status,
    status: row.final_status,
    suggestedComment: row.suggested_comment ?? "",
    finalComment: row.final_comment ?? "",
    evidence: parseEvidence(row.evidence_json),
    documentName: row.document_name,
    pageNumber: row.page_number,
    isBlocking: row.is_blocking !== 0,
    ruleSource: row.rule_source,
    overridden: Boolean(row.override_actor),
    overrideActor: row.override_actor,
    overridePreviousStatus: row.override_previous_status,
    overriddenAt: row.overridden_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function exportFromRow(row: ReviewExportRow, jobId: string) {
  return {
    type: row.export_type,
    r2Key: row.r2_key,
    filename: row.filename,
    size: row.size,
    ruleVersion: row.rule_version,
    templateVersion: row.template_version,
    submissionId: row.submission_id,
    generatedAt: row.generated_at,
    createdAt: row.created_at,
    downloadUrl: `/api/edp-reviews/${encodeURIComponent(jobId)}/exports/${row.export_type}/download`,
  };
}

async function reviewJobRow(db: D1Database, userId: string, jobId: string): Promise<ReviewJobRow | null> {
  return db.prepare(`SELECT job_id, school_key, school_name, submission_id, submitted_at, submission_round,
    source_r2_key, source_filename, work_name, instructor_name, instructor_email,
    rule_version, template_version, status, overall_status,
    superseded_by, last_error, reviewed_at, finalized_at, created_at, updated_at
    FROM edp_review_jobs WHERE user_id = ? AND job_id = ?`)
    .bind(userId, jobId).first<ReviewJobRow>();
}

async function reviewItems(db: D1Database, userId: string, jobId: string): Promise<ReviewItemRow[]> {
  const result = await db.prepare(`SELECT rule_id, worksheet_name, template_row, automatic_status, final_status,
    suggested_comment, final_comment, evidence_json, document_name, page_number, override_actor,
    is_blocking, rule_source, override_previous_status, overridden_at, created_at, updated_at
    FROM edp_review_items WHERE user_id = ? AND job_id = ? ORDER BY template_row`)
    .bind(userId, jobId).all<ReviewItemRow>();
  return result.results;
}

async function reviewExports(db: D1Database, userId: string, jobId: string): Promise<ReviewExportRow[]> {
  const result = await db.prepare(`SELECT export_type, r2_key, filename, size, rule_version,
    template_version, submission_id, generated_at, created_at
    FROM edp_review_exports WHERE user_id = ? AND job_id = ? ORDER BY export_type`)
    .bind(userId, jobId).all<ReviewExportRow>();
  return result.results;
}

async function reviewDetail(db: D1Database, userId: string, jobId: string) {
  const row = await reviewJobRow(db, userId, jobId);
  if (!row) throw new EdpReviewApiError(404, "review_not_found", "未找到该 EDP 审核任务。");
  const [items, exports] = await Promise.all([
    reviewItems(db, userId, jobId),
    reviewExports(db, userId, jobId),
  ]);
  return {
    job: jobFromRow(row),
    items: items.map(itemFromRow),
    exports: exports.map((entry) => exportFromRow(entry, jobId)),
  };
}

function placeholderItem(
  rule: Pick<(typeof EDP_REVIEW_RULES)[number], "id" | "row" | "isBlocking" | "ruleSource">,
  submissionRound: EdpSubmissionRound,
): EdpAuditItem {
  if (rule.id === "moc" && submissionRound === 1) {
    return {
      ruleId: rule.id,
      row: rule.row,
      status: "not_applicable",
      isBlocking: rule.isBlocking,
      ruleSource: rule.ruleSource,
      suggestedComment: "第1次 EDP 提交不要求 MOC 文件。",
      evidence: [],
    };
  }
  return {
    ruleId: rule.id,
    row: rule.row,
    status: "needs_human",
    isBlocking: rule.isBlocking,
    ruleSource: rule.ruleSource,
    suggestedComment: rule.id === "vehicle_photo"
      ? "小车完整照片暂缓审核，本项不阻塞当前阶段的正式结论。"
      : "等待系统读取 EDP 并定位证据。",
    evidence: [],
  };
}

function insertReviewItemStatement(
  db: D1Database,
  userId: string,
  jobId: string,
  item: EdpAuditItem,
  now: string,
  finalStatus = item.status,
  finalComment: string | null = item.suggestedComment,
  claimedAt?: string,
) {
  const firstEvidence = item.evidence[0];
  return db.prepare(`INSERT INTO edp_review_items (
    user_id, job_id, rule_id, worksheet_name, template_row, automatic_status, final_status,
    suggested_comment, final_comment, evidence_json, document_name, page_number,
    is_blocking, rule_source, created_at, updated_at
  ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    ${claimedAt ? "WHERE EXISTS (SELECT 1 FROM edp_review_jobs WHERE user_id = ? AND job_id = ? AND status = 'processing' AND updated_at = ?)" : ""}`)
    .bind(
      userId,
      jobId,
      item.ruleId,
      item.worksheetName ?? "2) EDP Evaluation",
      item.row,
      item.status,
      finalStatus,
      item.suggestedComment,
      finalComment,
      JSON.stringify(item.evidence),
      firstEvidence?.filename ?? null,
      firstEvidence?.page ?? null,
      item.isBlocking ? 1 : 0,
      item.ruleSource,
      now,
      now,
      ...(claimedAt ? [userId, jobId, claimedAt] : []),
    );
}

function hasCompleteReviewItems(items: readonly Pick<ReviewItemRow, "rule_id">[]): boolean {
  const storedRuleIds = new Set(items.map(({ rule_id }) => rule_id));
  return EDP_AUDIT_RULE_IDS.every((ruleId) => storedRuleIds.has(ruleId));
}

async function activeRuleVersionForReview(db: D1Database, userId: string): Promise<string> {
  const row = await db.prepare(`SELECT document.rule_version
    FROM edp_review_settings AS settings
    JOIN edp_rule_documents AS document
      ON document.user_id = settings.user_id
     AND document.applicable_year = CAST(settings.competition_year AS INTEGER)
     AND document.status = 'active'
    WHERE settings.user_id = ?
    ORDER BY document.activated_at DESC, document.created_at DESC
    LIMIT 1`).bind(userId).first<{ rule_version: string }>();
  return row?.rule_version ?? EDP_REVIEW_RULE_VERSION;
}

interface QueueReviewOptions {
  ruleVersion?: string;
  supersedeExisting?: boolean;
  linkFromJobId?: string;
}

export async function queueEdpReviewForSubmission(
  env: EdpReviewApiEnv,
  userId: string,
  submission: EdpReviewSourceSubmission,
  options: QueueReviewOptions = {},
) {
  const ruleVersion = options.ruleVersion ?? await activeRuleVersionForReview(env.DB, userId);
  const supersedeExisting = options.supersedeExisting !== false;
  const sameVersion = await env.DB.prepare(`SELECT job_id, school_key, school_name, submission_id, submitted_at,
    submission_round, source_r2_key, source_filename, work_name, instructor_name, instructor_email,
    rule_version, template_version, status, overall_status,
    superseded_by, last_error, reviewed_at, finalized_at, created_at, updated_at
    FROM edp_review_jobs WHERE user_id = ? AND school_key = ? AND submission_id = ? AND rule_version = ?`)
    .bind(userId, submission.schoolKey, submission.submissionId, ruleVersion)
    .first<ReviewJobRow>();
  if (sameVersion) {
    const now = new Date().toISOString();
    if (supersedeExisting) {
      await env.DB.prepare(`UPDATE edp_review_jobs SET status = 'superseded', superseded_by = ?, updated_at = ?
        WHERE user_id = ? AND school_key = ? AND job_id <> ? AND status <> 'superseded'`)
        .bind(sameVersion.job_id, now, userId, submission.schoolKey, sameVersion.job_id).run();
    } else if (options.linkFromJobId) {
      await env.DB.prepare(`UPDATE edp_review_jobs SET superseded_by = ?, updated_at = ?
        WHERE user_id = ? AND job_id = ?`)
        .bind(sameVersion.job_id, now, userId, options.linkFromJobId).run();
    }
    return jobFromRow(sameVersion);
  }

  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  const placeholders = EDP_REVIEW_RULES.map((rule) => placeholderItem(rule, submission.submissionRound));
  const statements: D1PreparedStatement[] = [];
  if (supersedeExisting) {
    statements.push(env.DB.prepare(`UPDATE edp_review_jobs SET status = 'superseded', superseded_by = ?, updated_at = ?
      WHERE user_id = ? AND school_key = ? AND status <> 'superseded'`)
      .bind(jobId, now, userId, submission.schoolKey));
  } else if (options.linkFromJobId) {
    statements.push(env.DB.prepare(`UPDATE edp_review_jobs SET superseded_by = ?, updated_at = ?
      WHERE user_id = ? AND job_id = ?`).bind(jobId, now, userId, options.linkFromJobId));
  }
  statements.push(
    env.DB.prepare(`INSERT INTO edp_review_jobs (
      user_id, job_id, school_key, school_name, submission_id, submitted_at, submission_round,
      source_r2_key, source_filename, rule_version, template_version, status, overall_status,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'pending', ?, ?)`)
      .bind(
        userId,
        jobId,
        submission.schoolKey,
        submission.schoolName,
        submission.submissionId,
        submission.submittedAt,
        submission.submissionRound,
        submission.sourceR2Key,
        submission.sourceFilename,
        ruleVersion,
        EDP_REVIEW_TEMPLATE_VERSION,
        now,
        now,
      ),
    ...placeholders.map((item) => insertReviewItemStatement(env.DB, userId, jobId, item, now)),
  );
  await env.DB.batch(statements);
  const created = await reviewJobRow(env.DB, userId, jobId);
  if (!created) throw new Error("EDP review job disappeared after insertion");
  return jobFromRow(created);
}

interface ReviewSyncSubmissionRow {
  school_key: string;
  school_name: string;
  submission_id: string;
  submitted_at: string;
  submission_round: number | null;
  submission_round_source: "captured" | "legacy_unknown" | "inferred_file_count" | "inferred_current_setting";
  archive_format: "zip" | "7z" | "rar";
  r2_key: string;
  filename: string;
  file_count: number;
}

export interface EdpReviewSyncResult {
  created: number;
  existing: number;
  failed: number;
  historicalRoundInferences: number;
  failures: Array<{ schoolKey: string; schoolName: string; message: string }>;
}

function isSubmissionRound(value: unknown): value is EdpSubmissionRound {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 5;
}

export async function syncMissingEdpReviewJobs(
  env: EdpReviewApiEnv,
  userId: string,
): Promise<EdpReviewSyncResult> {
  const [submissionResult, receiptSettings, ruleVersion] = await Promise.all([
    env.DB.prepare(`SELECT school_key, school_name, submission_id, submitted_at, submission_round,
      submission_round_source, archive_format, r2_key, filename, file_count
      FROM edp_submissions WHERE user_id = ? ORDER BY submitted_at DESC, school_key LIMIT 500`)
      .bind(userId).all<ReviewSyncSubmissionRow>(),
    env.DB.prepare("SELECT submission_round FROM edp_receipt_settings WHERE user_id = ?")
      .bind(userId).first<{ submission_round: number | null }>(),
    activeRuleVersionForReview(env.DB, userId),
  ]);
  const result: EdpReviewSyncResult = {
    created: 0,
    existing: 0,
    failed: 0,
    historicalRoundInferences: 0,
    failures: [],
  };

  for (const row of submissionResult.results ?? []) {
    try {
      let submissionRound = isSubmissionRound(row.submission_round) ? row.submission_round : null;
      let roundSource = row.submission_round_source;
      if (submissionRound === null) {
        if (row.file_count === 3) {
          submissionRound = 1;
          roundSource = "inferred_file_count";
        } else if (
          row.file_count === 4
          && isSubmissionRound(receiptSettings?.submission_round)
          && receiptSettings.submission_round >= 2
        ) {
          submissionRound = receiptSettings.submission_round;
          roundSource = "inferred_current_setting";
        } else {
          throw new Error(
            row.file_count === 4
              ? "历史 4 文件 EDP 缺少明确的第2至第5次提交轮次，请先保存当前 EDP 提交轮次后重试。"
              : `历史 EDP 记录为 ${row.file_count} 个文件，无法可靠推断提交轮次。`,
          );
        }
        const update = await env.DB.prepare(`UPDATE edp_submissions
          SET submission_round = ?, submission_round_source = ?
          WHERE user_id = ? AND school_key = ? AND submitted_at = ? AND submission_id = ?
            AND submission_round IS NULL`)
          .bind(submissionRound, roundSource, userId, row.school_key, row.submitted_at, row.submission_id).run();
        if ((update.meta.changes ?? 0) > 0) result.historicalRoundInferences += 1;
      }

      const existing = await env.DB.prepare(`SELECT job_id FROM edp_review_jobs
        WHERE user_id = ? AND school_key = ? AND submission_id = ? AND rule_version = ? LIMIT 1`)
        .bind(userId, row.school_key, row.submission_id, ruleVersion).first<{ job_id: string }>();
      if (existing) {
        result.existing += 1;
        continue;
      }
      await queueEdpReviewForSubmission(env, userId, {
        schoolKey: row.school_key,
        schoolName: row.school_name,
        submissionId: row.submission_id,
        submittedAt: row.submitted_at,
        submissionRound,
        sourceR2Key: row.r2_key,
        sourceFilename: row.filename,
      }, { ruleVersion, supersedeExisting: false });
      result.created += 1;
    } catch (error) {
      result.failed += 1;
      result.failures.push({
        schoolKey: row.school_key,
        schoolName: row.school_name,
        message: error instanceof Error ? error.message : "无法建立审核任务。",
      });
    }
  }
  return result;
}

async function updateSettings(request: Request, env: EdpReviewApiEnv, userId: string): Promise<Response> {
  if (request.method === "GET") {
    const row = await env.DB.prepare(`SELECT competition_year, safety_reviewer_name, safety_reviewer_email,
      expert_member_name, expert_member_email, template_version, active_rule_document_id,
      active_rule_version, updated_at
      FROM edp_review_settings WHERE user_id = ?`).bind(userId).first<ReviewSettingsRow>();
    return json({ ok: true, settings: settingsFromRow(row) });
  }
  if (request.method !== "PUT") return methodNotAllowed(["GET", "PUT"]);
  const body = await readJson(request);
  const competitionYear = textField(body, "competitionYear", 4);
  if (!/^\d{4}$/u.test(competitionYear)) {
    throw new EdpReviewApiError(400, "invalid_competition_year", "竞赛年份必须是 4 位数字。");
  }
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO edp_review_settings (
    user_id, competition_year, safety_reviewer_name, safety_reviewer_email,
    expert_member_name, expert_member_email, template_version, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET
    competition_year = excluded.competition_year,
    safety_reviewer_name = excluded.safety_reviewer_name,
    safety_reviewer_email = excluded.safety_reviewer_email,
    expert_member_name = excluded.expert_member_name,
    expert_member_email = excluded.expert_member_email,
    template_version = excluded.template_version,
    updated_at = excluded.updated_at`)
    .bind(
      userId,
      competitionYear,
      FIXED_EDP_REVIEW_PERSONNEL.safetyReviewerName,
      FIXED_EDP_REVIEW_PERSONNEL.safetyReviewerEmail,
      FIXED_EDP_REVIEW_PERSONNEL.expertMemberName,
      "",
      EDP_REVIEW_TEMPLATE_VERSION,
      now,
    ).run();
  const row = await env.DB.prepare(`SELECT competition_year, safety_reviewer_name, safety_reviewer_email,
    expert_member_name, expert_member_email, template_version, active_rule_document_id,
    active_rule_version, updated_at
    FROM edp_review_settings WHERE user_id = ?`).bind(userId).first<ReviewSettingsRow>();
  return json({ ok: true, settings: settingsFromRow(row) });
}

async function listReviews(request: Request, env: EdpReviewApiEnv, userId: string): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  const rows = await env.DB.prepare(`SELECT job.job_id, job.school_key, job.school_name, job.submission_id,
    job.submitted_at, job.submission_round, job.source_r2_key, job.source_filename, job.rule_version,
    job.work_name, job.instructor_name, job.instructor_email,
    job.template_version, job.status, job.overall_status, job.superseded_by, job.last_error,
    job.reviewed_at, job.finalized_at, job.created_at, job.updated_at,
    submission.archive_format AS archive_format,
    submission.submission_round_source AS submission_round_source
    FROM edp_review_jobs AS job
    LEFT JOIN edp_submissions AS submission
      ON submission.user_id = job.user_id
     AND submission.school_key = job.school_key
     AND submission.submission_id = job.submission_id
    WHERE job.user_id = ? ORDER BY job.submitted_at DESC, job.created_at DESC LIMIT 500`)
    .bind(userId).all<ReviewJobRow>();
  return json({ ok: true, jobs: rows.results.map(jobFromRow) });
}

async function getReview(request: Request, env: EdpReviewApiEnv, userId: string, jobId: string): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  return json({ ok: true, ...(await reviewDetail(env.DB, userId, jobId)) });
}

async function registrationReferenceForReview(
  env: EdpReviewApiEnv,
  userId: string,
  job: ReviewJobRow,
) {
  const registration = await env.DB.prepare(`SELECT r2_key
    FROM collector_registrations WHERE user_id = ? AND school_key = ?`)
    .bind(userId, job.school_key).first<{ r2_key: string }>();
  if (!registration) return null;
  const object = await env.FILES.get(registration.r2_key);
  if (!object) return null;
  try {
    const assessment = assessRegistrationWorkbook(await object.arrayBuffer(), job.school_name);
    return {
      schoolName: assessment.summary.schoolName,
      captainName: assessment.summary.leaderName,
      teamName: assessment.summary.teamName,
    };
  } catch {
    return null;
  }
}

async function annualFactsForLockedVersion(
  db: D1Database,
  userId: string,
  ruleVersion: string,
): Promise<AnnualRuleFactForReview[]> {
  if (ruleVersion === EDP_REVIEW_RULE_VERSION) return [];
  const document = await db.prepare(`SELECT document_id FROM edp_rule_documents
    WHERE user_id = ? AND rule_version = ? AND status IN ('active','archived')
    ORDER BY activated_at DESC, created_at DESC LIMIT 1`)
    .bind(userId, ruleVersion).first<{ document_id: string }>();
  if (!document) {
    throw new EdpReviewApiError(409, "locked_rule_missing", "该审核任务锁定的年度规则已不存在，无法保证历史审核一致性。");
  }
  const rows = await db.prepare(`SELECT fact_id, category, normalized_requirement, operator,
    structured_value, structured_unit, source_page, evidence_excerpt, confidence, confirmation_status
    FROM edp_rule_facts WHERE user_id = ? AND document_id = ? ORDER BY source_page, fact_id`)
    .bind(userId, document.document_id).all<AnnualRuleFactRow>();
  return (rows.results ?? []).map((row) => ({
    factId: row.fact_id,
    category: row.category,
    normalizedRequirement: row.normalized_requirement,
    operator: row.operator,
    value: row.structured_value,
    unit: row.structured_unit,
    page: row.source_page,
    excerpt: row.evidence_excerpt,
    confidence: row.confidence,
    confirmationStatus: row.confirmation_status,
  }));
}

async function ruleFilenameForVersion(db: D1Database, userId: string, ruleVersion: string): Promise<string> {
  if (ruleVersion === EDP_REVIEW_RULE_VERSION) return "内置 EDP 审核规则";
  const row = await db.prepare(`SELECT filename FROM edp_rule_documents
    WHERE user_id = ? AND rule_version = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(userId, ruleVersion).first<{ filename: string }>();
  return row?.filename ?? "年度竞赛规则（原文件记录缺失）";
}

async function runReviewJob(env: EdpReviewApiEnv, userId: string, jobId: string) {
  const row = await reviewJobRow(env.DB, userId, jobId);
  if (!row) throw new EdpReviewApiError(404, "review_not_found", "未找到该 EDP 审核任务。");
  if (row.status === "superseded") {
    throw new EdpReviewApiError(409, "review_superseded", "该任务已被更新版 EDP 取代，请审核最新任务。");
  }

  const startedAt = new Date().toISOString();
  // D1 atomically claims one school across tabs/cron, bounding PDF memory.
  // The timestamp identifies this attempt; replacement/deletion cancels it.
  const claim = await env.DB.prepare(`UPDATE edp_review_jobs SET status = 'processing', last_error = NULL, updated_at = ?
    WHERE user_id = ? AND job_id = ? AND status NOT IN ('processing','superseded')
    AND NOT EXISTS (SELECT 1 FROM edp_review_jobs WHERE status = 'processing')`)
    .bind(startedAt, userId, jobId).run();
  if (!claim.meta.changes) throw new EdpReviewApiError(409, "review_busy", "已有学校正在审核，本任务会继续排队。");

  try {
    if (!row.source_r2_key) throw new Error("审核任务没有关联 EDP 文件。");
    const source = await env.FILES.get(row.source_r2_key);
    if (!source) throw new Error("审核任务关联的 EDP 文件已不存在。");
    const [sourceBytes, previousItems, registrationReference, annualRuleFacts, reviewSettings] = await Promise.all([
      source.arrayBuffer(),
      reviewItems(env.DB, userId, jobId),
      registrationReferenceForReview(env, userId, row),
      annualFactsForLockedVersion(env.DB, userId, row.rule_version),
      reviewSettingsRow(env.DB, userId),
    ]);
    const result = await auditEdpArchive(sourceBytes, {
      archiveFilename: row.source_filename || "EDP.zip",
      submissionRound: row.submission_round as EdpSubmissionRound,
      competitionYear: reviewSettings?.competition_year,
      registrationReference,
      ruleVersion: row.rule_version,
      annualRuleFacts,
    });
    const previousByRule = new Map(previousItems.map((item) => [item.rule_id, item]));
    const now = new Date().toISOString();
    const current = await reviewJobRow(env.DB, userId, jobId);
    if (!current || current.status !== "processing" || current.updated_at !== startedAt) {
      throw new EdpReviewApiError(409, "review_cancelled", "任务已删除或由新版本替代，本次审核结果未写回。");
    }
    const statements = [env.DB.prepare(`DELETE FROM edp_review_items WHERE user_id = ? AND job_id = ?
      AND EXISTS (SELECT 1 FROM edp_review_jobs WHERE user_id = ? AND job_id = ? AND status = 'processing' AND updated_at = ?)`)
      .bind(userId, jobId, userId, jobId, startedAt)];
    for (const item of result.items) {
      const previous = previousByRule.get(item.ruleId);
      const keepOverride = Boolean(previous?.override_actor);
      statements.push(insertReviewItemStatement(
        env.DB,
        userId,
        jobId,
        item,
        now,
        keepOverride ? previous!.final_status : item.status,
        keepOverride ? previous!.final_comment : item.suggestedComment,
        startedAt,
      ));
      if (keepOverride) statements.push(env.DB.prepare(`UPDATE edp_review_items
        SET override_actor = ?, override_previous_status = ?, overridden_at = ?
        WHERE user_id = ? AND job_id = ? AND rule_id = ?
        AND EXISTS (SELECT 1 FROM edp_review_jobs WHERE user_id = ? AND job_id = ? AND status = 'processing' AND updated_at = ?)`)
        .bind(previous!.override_actor, previous!.override_previous_status, previous!.overridden_at,
          userId, jobId, item.ruleId, userId, jobId, startedAt));
    }
    const effectiveStatuses = result.items.map((item) => ({
      status: previousByRule.get(item.ruleId)?.override_actor
        ? previousByRule.get(item.ruleId)!.final_status
        : item.status,
      isBlocking: item.isBlocking,
    }));
    const overallStatus = computeOverallReviewStatus(effectiveStatuses);
    const hasBlockingUnresolved = effectiveStatuses.some(({ status, isBlocking }) => status === "needs_human" && isBlocking !== false);
    const status = hasBlockingUnresolved ? "needs_human" : "ready";
    statements.push(env.DB.prepare(`UPDATE edp_review_jobs SET status = ?, overall_status = ?,
      rule_version = ?, work_name = ?, instructor_name = ?, instructor_email = ?,
      last_error = NULL, reviewed_at = ?, finalized_at = NULL, updated_at = ?
      WHERE user_id = ? AND job_id = ? AND status = 'processing' AND updated_at = ?`)
      .bind(
        status,
        overallStatus,
        result.ruleVersion,
        result.workbookIdentity.workName || null,
        result.workbookIdentity.instructorName || null,
        result.workbookIdentity.instructorEmail || null,
        now,
        now,
        userId,
        jobId,
        startedAt,
      ));
    await env.DB.batch(statements);
    return { ...(await reviewDetail(env.DB, userId, jobId)), warnings: result.warnings };
  } catch (error) {
    const now = new Date().toISOString();
    const message = error instanceof Error ? error.message.slice(0, 1000) : "未知审核错误";
    await env.DB.prepare(`UPDATE edp_review_jobs SET status = 'failed', overall_status = 'pending',
      last_error = ?, updated_at = ? WHERE user_id = ? AND job_id = ? AND status = 'processing' AND updated_at = ?`)
      .bind(message, now, userId, jobId, startedAt).run();
    throw new EdpReviewApiError(422, "review_archive_failed", message);
  }
}

// Jobs are durable in D1. Each invocation audits one school; exports are a
// separate action. A killed runtime is surfaced as retryable, never "failed EDP".
export async function processNextEdpReview(env: EdpReviewApiEnv, userId: string) {
  const cutoff = new Date(Date.now() - 10 * 60_000).toISOString();
  await env.DB.prepare(`UPDATE edp_review_jobs SET status='failed', overall_status='pending',
    last_error='上次审核中断或超时。原文件和已有结果保留，可点击重新审核。',
    updated_at=? WHERE user_id=? AND status='processing' AND updated_at < ?`)
    .bind(new Date().toISOString(), userId, cutoff).run();
  const pending = await env.DB.prepare(`SELECT job_id FROM edp_review_jobs
    WHERE user_id=? AND status='queued' ORDER BY created_at,job_id LIMIT 1`)
    .bind(userId).first<{job_id:string}>();
  if (!pending) return {worked:false};
  try {
    await runReviewJob(env,userId,pending.job_id);
    return {worked:true,jobId:pending.job_id};
  } catch (error) {
    if (error instanceof EdpReviewApiError && error.code === "review_busy") return {worked:false,busy:true};
    return {worked:true,jobId:pending.job_id,failed:true,message:error instanceof Error ? error.message : "审核失败"};
  }
}

async function enqueueReviews(request: Request, env: EdpReviewApiEnv, userId: string) {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  const {jobIds} = await readJson(request);
  if (!Array.isArray(jobIds) || !jobIds.length || jobIds.length > 100 ||
      jobIds.some(id => typeof id !== "string" || !id.trim() || id.length > 100)) {
    throw new EdpReviewApiError(400,"invalid_job_ids","请选择 1–100 个审核任务。");
  }
  const accepted: string[] = [];
  const failures: Array<{jobId:string;message:string}> = [];
  for (const id of [...new Set(jobIds)] as string[]) {
    const row = await reviewJobRow(env.DB,userId,id);
    if (!row || row.status === "superseded") { failures.push({jobId:id,message:"任务已删除或被新版本替代。"}); continue; }
    if (row.status !== "processing") await env.DB.prepare(`UPDATE edp_review_jobs
      SET status='queued', overall_status='pending', last_error=NULL, updated_at=?
      WHERE user_id=? AND job_id=? AND status NOT IN ('processing','superseded')`)
      .bind(new Date().toISOString(),userId,id).run();
    accepted.push(id);
  }
  return json({ok:true,accepted,failures},202);
}

async function runReview(request: Request, env: EdpReviewApiEnv, userId: string, jobId: string): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  return json({ ok: true, ...(await runReviewJob(env, userId, jobId)) });
}

async function recheckWithLatestRule(
  request: Request,
  env: EdpReviewApiEnv,
  userId: string,
  jobId: string,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  const previous = await reviewJobRow(env.DB, userId, jobId);
  if (!previous) throw new EdpReviewApiError(404, "review_not_found", "未找到该 EDP 审核任务。");
  if (!previous.source_r2_key) {
    throw new EdpReviewApiError(409, "review_source_missing", "该审核任务没有可供重新审核的 EDP 原始文件。");
  }
  const latestRuleVersion = await activeRuleVersionForReview(env.DB, userId);
  if (latestRuleVersion === previous.rule_version) {
    throw new EdpReviewApiError(409, "review_already_uses_latest_rule", "该任务已经使用当前启用的年度规则，无需重复创建。");
  }
  const existing = await env.DB.prepare(`SELECT job_id FROM edp_review_jobs
    WHERE user_id = ? AND school_key = ? AND submission_id = ? AND rule_version = ?`)
    .bind(userId, previous.school_key, previous.submission_id, latestRuleVersion)
    .first<{ job_id: string }>();
  const created = await queueEdpReviewForSubmission(env, userId, {
    schoolKey: previous.school_key,
    schoolName: previous.school_name,
    submissionId: previous.submission_id,
    submittedAt: previous.submitted_at,
    submissionRound: previous.submission_round as EdpSubmissionRound,
    sourceR2Key: previous.source_r2_key,
    sourceFilename: previous.source_filename ?? "EDP.zip",
  }, {
    ruleVersion: latestRuleVersion,
    supersedeExisting: false,
    linkFromJobId: previous.job_id,
  });
  const linkedPrevious = await reviewJobRow(env.DB, userId, previous.job_id);
  if (!linkedPrevious) throw new EdpReviewApiError(500, "review_not_found", "旧审核任务在建立复核关系后无法读取。");
  return json({
    ok: true,
    job: created,
    previousJob: jobFromRow(linkedPrevious),
    reused: Boolean(existing),
  }, existing ? 200 : 201);
}

async function updateReviewItem(
  request: Request,
  env: EdpReviewApiEnv,
  userId: string,
  jobId: string,
  ruleId: string,
): Promise<Response> {
  if (request.method !== "PUT") return methodNotAllowed(["PUT"]);
  const job = await reviewJobRow(env.DB, userId, jobId);
  if (!job) throw new EdpReviewApiError(404, "review_not_found", "未找到该 EDP 审核任务。");
  if (job.status === "superseded") throw new EdpReviewApiError(409, "review_superseded", "旧版本审核不能再修改。");
  const body = await readJson(request);
  const requestedStatus = textField(body, "status", 32) as EdpReviewStatus;
  if (!["yes", "no", "not_applicable", "needs_human"].includes(requestedStatus)) {
    throw new EdpReviewApiError(400, "invalid_review_status", "审核结论不在允许范围内。");
  }
  const requestedComment = textField(body, "comment", 2000);
  const firstRoundMoc = ruleId === "moc" && job.submission_round === 1;
  const status = firstRoundMoc ? "not_applicable" : requestedStatus;
  const comment = firstRoundMoc ? "第1次 EDP 提交不要求 MOC 文件。" : requestedComment;
  if ((status === "no" || status === "not_applicable") && !comment) {
    throw new EdpReviewApiError(400, "review_comment_required", "选择“不符合”或“不适用”时必须填写具体说明。");
  }
  const current = await env.DB.prepare(`SELECT final_status FROM edp_review_items
    WHERE user_id = ? AND job_id = ? AND rule_id = ?`)
    .bind(userId, jobId, ruleId).first<{ final_status: EdpReviewStatus }>();
  if (!current) throw new EdpReviewApiError(404, "review_item_not_found", "未找到该审核条目。");
  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE edp_review_items SET final_status = ?, final_comment = ?,
    override_actor = 'shared-operator', override_previous_status = ?, overridden_at = ?, updated_at = ?
    WHERE user_id = ? AND job_id = ? AND rule_id = ?`)
    .bind(status, comment || null, current.final_status, now, now, userId, jobId, ruleId).run();
  const items = await reviewItems(env.DB, userId, jobId);
  const effectiveStatuses = items.map((item) => ({
    status: item.final_status,
    isBlocking: item.is_blocking !== 0,
  }));
  const overallStatus = computeOverallReviewStatus(effectiveStatuses);
  const hasBlockingUnresolved = effectiveStatuses.some(({ status: itemStatus, isBlocking }) => itemStatus === "needs_human" && isBlocking);
  const jobStatus = hasBlockingUnresolved ? "needs_human" : "ready";
  await env.DB.prepare(`UPDATE edp_review_jobs SET status = ?, overall_status = ?, finalized_at = NULL, updated_at = ?
    WHERE user_id = ? AND job_id = ?`).bind(jobStatus, overallStatus, now, userId, jobId).run();
  return json({ ok: true, ...(await reviewDetail(env.DB, userId, jobId)) });
}

async function finalizeReview(request: Request, env: EdpReviewApiEnv, userId: string, jobId: string): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  const row = await reviewJobRow(env.DB, userId, jobId);
  if (!row) throw new EdpReviewApiError(404, "review_not_found", "未找到该 EDP 审核任务。");
  if (row.status === "superseded") throw new EdpReviewApiError(409, "review_superseded", "旧版本审核不能定稿。");
  const items = await reviewItems(env.DB, userId, jobId);
  if (!hasCompleteReviewItems(items) || items.some((item) => item.final_status === "needs_human" && item.is_blocking !== 0)) {
    throw new EdpReviewApiError(409, "review_unresolved", "仍有待人工确认的审核项，不能生成正式审核结论。");
  }
  const overallStatus = computeOverallReviewStatus(items.map((item) => ({
    status: item.final_status,
    isBlocking: item.is_blocking !== 0,
  })));
  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE edp_review_jobs SET status = 'completed', overall_status = ?,
    finalized_at = ?, updated_at = ? WHERE user_id = ? AND job_id = ?`)
    .bind(overallStatus, now, now, userId, jobId).run();
  return json({ ok: true, ...(await reviewDetail(env.DB, userId, jobId)) });
}

function safeFilenamePart(value: string): string {
  return value.normalize("NFKC").replace(/[\\/:*?"<>|\r\n\0]/gu, "_").trim().slice(0, 100) || "学校";
}

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[\r\n"]/gu, "_").replace(/[^\x20-\x7E]/gu, "_") || "EDP-review.xlsx";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function reviewSettingsRow(db: D1Database, userId: string): Promise<ReviewSettingsRow | null> {
  return db.prepare(`SELECT competition_year, safety_reviewer_name, safety_reviewer_email,
    expert_member_name, expert_member_email, template_version, active_rule_document_id,
    active_rule_version, updated_at
    FROM edp_review_settings WHERE user_id = ?`).bind(userId).first<ReviewSettingsRow>();
}

interface GeneratedReviewExport {
  job: ReviewJobRow;
  stored: ReviewExportRow;
  workbook: Uint8Array;
  unresolved: boolean;
}

async function loadReviewTemplateBytes(request: Request, env: EdpReviewApiEnv): Promise<ArrayBuffer> {
  if (!env.ASSETS) throw new EdpReviewApiError(503, "review_template_unavailable", "站点静态资源服务尚未连接。");
  const templateResponse = await env.ASSETS.fetch(new Request(new URL("/edp-review-template-v1.xlsx", request.url)));
  if (!templateResponse.ok) {
    throw new EdpReviewApiError(503, "review_template_unavailable", "EDP 审核 Excel 模板暂时无法读取。");
  }
  return templateResponse.arrayBuffer();
}

async function generateReviewExport(
  request: Request,
  env: EdpReviewApiEnv,
  userId: string,
  jobId: string,
  exportType: "draft" | "final",
  providedTemplateBytes?: ArrayBuffer,
): Promise<GeneratedReviewExport> {
  const [job, items, settings] = await Promise.all([
    reviewJobRow(env.DB, userId, jobId),
    reviewItems(env.DB, userId, jobId),
    reviewSettingsRow(env.DB, userId),
  ]);
  if (!job) throw new EdpReviewApiError(404, "review_not_found", "未找到该 EDP 审核任务。");
  if (job.status === "superseded") throw new EdpReviewApiError(409, "review_superseded", "旧版本审核不能导出。");
  if (!job.reviewed_at || ["queued", "processing", "failed"].includes(job.status)) {
    throw new EdpReviewApiError(409, "review_not_ready", "审核尚未完成，请先查看任务状态；下载不会触发重新审核。");
  }
  if (!settings || !/^\d{4}$/u.test(settings.competition_year)) {
    throw new EdpReviewApiError(409, "review_settings_incomplete", "请先保存 4 位竞赛年份，再生成审核 Excel。");
  }
  if (!hasCompleteReviewItems(items)) {
    throw new EdpReviewApiError(409, "review_items_incomplete", "审核条目尚未完整建立，请先重新审核。");
  }
  const unresolved = items.some((item) => item.final_status === "needs_human" && item.is_blocking !== 0);
  if (exportType === "final" && unresolved) {
    throw new EdpReviewApiError(409, "review_unresolved", "仍有待人工确认的审核项，不能生成正式审核 Excel。");
  }
  const templateBytes = providedTemplateBytes ?? await loadReviewTemplateBytes(request, env);
  const overallStatus = unresolved
    ? "needs_human"
    : computeOverallReviewStatus(items.map((item) => ({
      status: item.final_status,
      isBlocking: item.is_blocking !== 0,
    })));
  const ruleFilename = await ruleFilenameForVersion(env.DB, userId, job.rule_version);
  const generatedAt = new Date().toISOString();
  const workbook = await buildEdpReviewWorkbook(templateBytes, {
    schoolName: job.school_name,
    workName: job.work_name ?? "",
    instructorName: job.instructor_name ?? "",
    instructorEmail: job.instructor_email ?? "",
    competitionYear: settings.competition_year,
    submissionRound: job.submission_round as EdpSubmissionRound,
    reviewedAt: job.reviewed_at ?? generatedAt,
    overallStatus,
    safetyReviewerName: FIXED_EDP_REVIEW_PERSONNEL.safetyReviewerName,
    safetyReviewerEmail: FIXED_EDP_REVIEW_PERSONNEL.safetyReviewerEmail,
    expertMemberName: FIXED_EDP_REVIEW_PERSONNEL.expertMemberName,
    ruleFilename,
    ruleVersion: job.rule_version,
    items: items.map((item) => ({
      ruleId: item.rule_id,
      worksheetName: item.worksheet_name as "1) EDP Cover Page" | "2) EDP Evaluation",
      row: item.template_row,
      status: item.final_status,
      comment: item.final_comment || item.suggested_comment || "请人工核对。",
      evidence: parseEvidence(item.evidence_json),
    })),
  });
  const suffix = exportType === "draft" ? "__草稿" : "";
  const filename = `第${job.submission_round}次EDP审核意见__${safeFilenamePart(job.school_name)}${suffix}.xlsx`;
  const r2Key = `users/${encodeURIComponent(userId)}/edp-reviews/${encodeURIComponent(jobId)}/${exportType}.xlsx`;
  await env.FILES.put(r2Key, workbook, {
    httpMetadata: { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
    customMetadata: {
      jobId,
      exportType,
      ruleVersion: job.rule_version,
      templateVersion: job.template_version,
      submissionId: job.submission_id,
    },
  });
  await env.DB.prepare(`INSERT INTO edp_review_exports (
    user_id, job_id, export_type, r2_key, filename, size, rule_version,
    template_version, submission_id, generated_at, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, job_id, export_type) DO UPDATE SET
    r2_key = excluded.r2_key,
    filename = excluded.filename,
    size = excluded.size,
    rule_version = excluded.rule_version,
    template_version = excluded.template_version,
    submission_id = excluded.submission_id,
    generated_at = excluded.generated_at`)
    .bind(
      userId,
      jobId,
      exportType,
      r2Key,
      filename,
      workbook.byteLength,
      job.rule_version,
      job.template_version,
      job.submission_id,
      generatedAt,
      generatedAt,
    ).run();
  if (exportType === "final") {
    await env.DB.prepare(`UPDATE edp_review_jobs SET status = 'completed', overall_status = ?,
      finalized_at = COALESCE(finalized_at, ?), updated_at = ? WHERE user_id = ? AND job_id = ?`)
      .bind(overallStatus, generatedAt, generatedAt, userId, jobId).run();
  }
  const stored = await env.DB.prepare(`SELECT export_type, r2_key, filename, size, rule_version,
    template_version, submission_id, generated_at, created_at FROM edp_review_exports
    WHERE user_id = ? AND job_id = ? AND export_type = ?`)
    .bind(userId, jobId, exportType).first<ReviewExportRow>();
  if (!stored) throw new EdpReviewApiError(500, "review_export_missing", "审核 Excel 已生成，但索引写入失败。");
  return { job, stored, workbook, unresolved };
}

async function exportReview(
  request: Request,
  env: EdpReviewApiEnv,
  userId: string,
  jobId: string,
  exportType: "draft" | "final",
): Promise<Response> {
  if (request.method === "DELETE") {
    const existing = await env.DB.prepare(`SELECT export_type, r2_key, filename, size, rule_version,
      template_version, submission_id, generated_at, created_at FROM edp_review_exports
      WHERE user_id = ? AND job_id = ? AND export_type = ?`)
      .bind(userId, jobId, exportType).first<ReviewExportRow>();
    if (!existing) throw new EdpReviewApiError(404, "review_export_not_found", "未找到要删除的审核 Excel。");
    await env.DB.prepare("DELETE FROM edp_review_exports WHERE user_id = ? AND job_id = ? AND export_type = ?")
      .bind(userId, jobId, exportType).run();
    await env.FILES.delete(existing.r2_key);
    return json({ ok: true, deleted: true, export: exportFromRow(existing, jobId) });
  }
  if (request.method !== "POST") return methodNotAllowed(["POST", "DELETE"]);
  const generated = await generateReviewExport(request, env, userId, jobId, exportType);
  return json({ ok: true, export: exportFromRow(generated.stored, jobId) }, 201);
}

interface BatchReviewSuccess {
  schoolName: string;
  jobId: string;
  generated: GeneratedReviewExport;
}

interface BatchReviewFailure {
  schoolName: string;
  jobId: string;
  message: string;
}

function downloadHeaders(filename: string, contentType: string, contentLength: number): Headers {
  const headers = new Headers();
  headers.set("Content-Type", contentType);
  headers.set("Content-Disposition", contentDisposition(filename));
  headers.set("Content-Length", String(contentLength));
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return headers;
}

function batchSummary(successes: BatchReviewSuccess[], failures: BatchReviewFailure[]): string {
  const lines = [
    "EDP 批量审核结果",
    `生成时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}`,
    `成功：${successes.length} 所；失败：${failures.length} 所。`,
    "",
    "成功项目：",
    ...successes.map(({ schoolName, generated }) =>
      `${schoolName}：${generated.unresolved ? "草稿，含待人工确认项" : "正式审核表"}；${generated.stored.filename}`),
  ];
  if (failures.length) {
    lines.push("", "失败项目（其余学校已继续处理）：", ...failures.map(({ schoolName, message }) => `${schoolName}：${message}`));
  }
  return `${lines.join("\r\n")}\r\n`;
}

async function auditAndExportReviews(
  request: Request,
  env: EdpReviewApiEnv,
  userId: string,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  const body = await readJson(request);
  if (!Array.isArray(body.jobIds)) {
    throw new EdpReviewApiError(400, "invalid_job_ids", "请选择需要审核的学校。");
  }
  const jobIds = [...new Set(body.jobIds.map((value) => {
    if (typeof value !== "string" || !value.trim() || value.length > 100) {
      throw new EdpReviewApiError(400, "invalid_job_ids", "审核任务编号格式不正确。");
    }
    return value.trim();
  }))];
  if (!jobIds.length) throw new EdpReviewApiError(400, "invalid_job_ids", "请至少选择一所学校。");
  if (jobIds.length > 50) throw new EdpReviewApiError(400, "too_many_review_jobs", "一次最多审核 50 所学校。");

  const templateBytes = await loadReviewTemplateBytes(request, env);
  const successes: BatchReviewSuccess[] = [];
  const failures: BatchReviewFailure[] = [];
  for (const jobId of jobIds) {
    const existingJob = await reviewJobRow(env.DB, userId, jobId);
    const schoolName = existingJob?.school_name ?? `审核任务 ${jobId}`;
    try {
      const result = await reviewDetail(env.DB, userId, jobId);
      const unresolved = result.items.some((item) => item.finalStatus === "needs_human" && item.isBlocking);
      const generated = await generateReviewExport(
        request,
        env,
        userId,
        jobId,
        unresolved ? "draft" : "final",
        templateBytes,
      );
      successes.push({ schoolName, jobId, generated });
    } catch (error) {
      failures.push({
        schoolName,
        jobId,
        message: error instanceof Error ? error.message : "审核失败，原因未知。",
      });
    }
  }
  if (!successes.length) {
    throw new EdpReviewApiError(
      422,
      "batch_review_failed",
      failures.map(({ schoolName, message }) => `${schoolName}：${message}`).join("；").slice(0, 2000),
    );
  }

  successes.sort((left, right) => left.schoolName.localeCompare(right.schoolName, "zh-CN-u-co-pinyin"));
  const needsHuman = successes.filter(({ generated }) => generated.unresolved).length;
  if (jobIds.length === 1 && successes.length === 1) {
    const success = successes[0];
    const headers = downloadHeaders(
      success.generated.stored.filename,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      success.generated.workbook.byteLength,
    );
    headers.set("X-EDP-Review-Succeeded", "1");
    headers.set("X-EDP-Review-Failed", "0");
    headers.set("X-EDP-Review-Needs-Human", String(needsHuman));
    return new Response(new Uint8Array(success.generated.workbook), { headers });
  }

  const archive = new JSZip();
  for (const success of successes) {
    archive.file(success.generated.stored.filename, success.generated.workbook);
  }
  archive.file("批量审核结果.txt", batchSummary(successes, failures));
  const archiveBytes = await archive.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  const date = new Date().toLocaleDateString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).replaceAll("/", "-");
  const headers = downloadHeaders(`EDP审核意见__${date}.zip`, "application/zip", archiveBytes.byteLength);
  headers.set("X-EDP-Review-Succeeded", String(successes.length));
  headers.set("X-EDP-Review-Failed", String(failures.length));
  headers.set("X-EDP-Review-Needs-Human", String(needsHuman));
  return new Response(new Uint8Array(archiveBytes), { headers });
}

async function downloadReviewExport(
  request: Request,
  env: EdpReviewApiEnv,
  userId: string,
  jobId: string,
  exportType: "draft" | "final",
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  const row = await env.DB.prepare(`SELECT export_type, r2_key, filename, size, rule_version,
    template_version, submission_id, generated_at, created_at FROM edp_review_exports
    WHERE user_id = ? AND job_id = ? AND export_type = ?`)
    .bind(userId, jobId, exportType).first<ReviewExportRow>();
  if (!row) throw new EdpReviewApiError(404, "review_export_not_found", "未找到该审核 Excel。");
  const object = await env.FILES.get(row.r2_key);
  if (!object) throw new EdpReviewApiError(404, "review_export_missing", "审核 Excel 索引存在，但云端文件已丢失。");
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  headers.set("Content-Disposition", contentDisposition(row.filename));
  headers.set("Content-Length", String(object.size));
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(object.body, { headers });
}

export interface EdpSubmissionDeleteTarget {
  schoolKey: string;
  submissionId: string;
  submittedAt: string;
}

export interface EdpSubmissionDeleteResult {
  deleted: boolean;
  schoolName: string | null;
  deletedReviewJobs: number;
}

/**
 * Remove the current EDP and every derived review artifact for its school.
 * The exact submission version is required so an older screen cannot delete a
 * newer upload. Registration data is intentionally left untouched.
 */
export async function deleteEdpSubmissionAndReviews(
  env: EdpReviewApiEnv,
  userId: string,
  target: EdpSubmissionDeleteTarget,
): Promise<EdpSubmissionDeleteResult> {
  const current = await env.DB.prepare(`SELECT school_name, r2_key FROM edp_submissions
    WHERE user_id = ? AND school_key = ? AND submission_id = ? AND submitted_at = ?`)
    .bind(userId, target.schoolKey, target.submissionId, target.submittedAt)
    .first<{ school_name: string; r2_key: string }>();
  if (!current) return { deleted: false, schoolName: null, deletedReviewJobs: 0 };

  const [jobs, exports] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS total FROM edp_review_jobs WHERE user_id = ? AND school_key = ?`)
      .bind(userId, target.schoolKey).first<{ total: number }>(),
    env.DB.prepare(`SELECT export_row.r2_key FROM edp_review_exports AS export_row
      INNER JOIN edp_review_jobs AS job ON job.user_id = export_row.user_id AND job.job_id = export_row.job_id
      WHERE job.user_id = ? AND job.school_key = ?`)
      .bind(userId, target.schoolKey).all<{ r2_key: string }>(),
  ]);

  const currentGuard = `EXISTS (SELECT 1 FROM edp_submissions AS current
    WHERE current.user_id = ? AND current.school_key = ?
      AND current.submission_id = ? AND current.submitted_at = ?)`;
  const guardBindings = [userId, target.schoolKey, target.submissionId, target.submittedAt] as const;
  const results = await env.DB.batch([
    env.DB.prepare(`DELETE FROM edp_review_exports WHERE user_id = ?
      AND job_id IN (SELECT job_id FROM edp_review_jobs WHERE user_id = ? AND school_key = ?)
      AND ${currentGuard}`)
      .bind(userId, userId, target.schoolKey, ...guardBindings),
    env.DB.prepare(`DELETE FROM edp_review_items WHERE user_id = ?
      AND job_id IN (SELECT job_id FROM edp_review_jobs WHERE user_id = ? AND school_key = ?)
      AND ${currentGuard}`)
      .bind(userId, userId, target.schoolKey, ...guardBindings),
    env.DB.prepare(`DELETE FROM edp_review_jobs WHERE user_id = ? AND school_key = ? AND ${currentGuard}`)
      .bind(userId, target.schoolKey, ...guardBindings),
    env.DB.prepare(`DELETE FROM edp_issues WHERE user_id = ? AND school_key = ?
      AND submission_id = ? AND submitted_at = ? AND ${currentGuard}`)
      .bind(userId, target.schoolKey, target.submissionId, target.submittedAt, ...guardBindings),
    env.DB.prepare(`DELETE FROM edp_submissions
      WHERE user_id = ? AND school_key = ? AND submission_id = ? AND submitted_at = ?`)
      .bind(userId, target.schoolKey, target.submissionId, target.submittedAt),
  ]);
  if ((results.at(-1)?.meta.changes ?? 0) !== 1) {
    return { deleted: false, schoolName: current.school_name, deletedReviewJobs: 0 };
  }

  const objectKeys = new Set([current.r2_key, ...exports.results.map(({ r2_key }) => r2_key)]);
  await Promise.all([...objectKeys].map((key) => env.FILES.delete(key).catch((error) => {
    console.error("Could not remove deleted EDP artifact", { key, error });
  })));
  return {
    deleted: true,
    schoolName: current.school_name,
    deletedReviewJobs: Number(jobs?.total ?? 0),
  };
}

async function deleteOrphanReviewJobs(
  env: EdpReviewApiEnv,
  userId: string,
  job: ReviewJobRow,
): Promise<EdpSubmissionDeleteResult> {
  const [jobs, exports] = await Promise.all([
    env.DB.prepare(`SELECT source_r2_key FROM edp_review_jobs WHERE user_id = ? AND school_key = ?`)
      .bind(userId, job.school_key).all<{ source_r2_key: string | null }>(),
    env.DB.prepare(`SELECT export_row.r2_key FROM edp_review_exports AS export_row
      INNER JOIN edp_review_jobs AS review ON review.user_id = export_row.user_id AND review.job_id = export_row.job_id
      WHERE review.user_id = ? AND review.school_key = ?`)
      .bind(userId, job.school_key).all<{ r2_key: string }>(),
  ]);
  const noCurrentSubmission = `NOT EXISTS (SELECT 1 FROM edp_submissions AS current
    WHERE current.user_id = ? AND current.school_key = ?)`;
  const results = await env.DB.batch([
    env.DB.prepare(`DELETE FROM edp_review_exports WHERE user_id = ?
      AND job_id IN (SELECT job_id FROM edp_review_jobs WHERE user_id = ? AND school_key = ?)
      AND ${noCurrentSubmission}`)
      .bind(userId, userId, job.school_key, userId, job.school_key),
    env.DB.prepare(`DELETE FROM edp_review_items WHERE user_id = ?
      AND job_id IN (SELECT job_id FROM edp_review_jobs WHERE user_id = ? AND school_key = ?)
      AND ${noCurrentSubmission}`)
      .bind(userId, userId, job.school_key, userId, job.school_key),
    env.DB.prepare(`DELETE FROM edp_review_jobs WHERE user_id = ? AND school_key = ? AND ${noCurrentSubmission}`)
      .bind(userId, job.school_key, userId, job.school_key),
  ]);
  const deletedReviewJobs = Number(results.at(-1)?.meta.changes ?? 0);
  if (!deletedReviewJobs) return { deleted: false, schoolName: job.school_name, deletedReviewJobs: 0 };

  const objectKeys = new Set([
    ...jobs.results.map(({ source_r2_key }) => source_r2_key),
    ...exports.results.map(({ r2_key }) => r2_key),
  ].filter((key): key is string => Boolean(key)));
  await Promise.all([...objectKeys].map(async (key) => {
    const reference = await env.DB.prepare(`SELECT 1 AS present WHERE
      EXISTS (SELECT 1 FROM edp_submissions WHERE r2_key = ?)
      OR EXISTS (SELECT 1 FROM edp_review_jobs WHERE source_r2_key = ?)
      OR EXISTS (SELECT 1 FROM edp_review_exports WHERE r2_key = ?)`)
      .bind(key, key, key).first<{ present: number }>();
    if (!reference) await env.FILES.delete(key).catch((error) => {
      console.error("Could not remove deleted orphan EDP artifact", { key, error });
    });
  }));
  return { deleted: true, schoolName: job.school_name, deletedReviewJobs };
}

async function deleteReviewJobAndArtifacts(
  env: EdpReviewApiEnv,
  userId: string,
  job: ReviewJobRow,
): Promise<EdpSubmissionDeleteResult> {
  const current = await env.DB.prepare(`SELECT submission_id, submitted_at FROM edp_submissions
    WHERE user_id = ? AND school_key = ?`)
    .bind(userId, job.school_key).first<{ submission_id: string; submitted_at: string }>();
  if (current && (current.submission_id !== job.submission_id || current.submitted_at !== job.submitted_at)) {
    return { deleted: false, schoolName: job.school_name, deletedReviewJobs: 0 };
  }
  return current
    ? deleteEdpSubmissionAndReviews(env, userId, {
      schoolKey: job.school_key,
      submissionId: job.submission_id,
      submittedAt: job.submitted_at,
    })
    : deleteOrphanReviewJobs(env, userId, job);
}

async function deleteReviewSubmission(
  request: Request,
  env: EdpReviewApiEnv,
  userId: string,
  jobId: string,
): Promise<Response> {
  if (request.method !== "DELETE") return methodNotAllowed(["DELETE"]);
  const job = await reviewJobRow(env.DB, userId, jobId);
  if (!job) throw new EdpReviewApiError(404, "review_not_found", "未找到该 EDP 审核任务。");
  const result = await deleteReviewJobAndArtifacts(env, userId, job);
  if (!result.deleted) {
    throw new EdpReviewApiError(409, "edp_changed", "该校 EDP 已被更新或删除；请刷新列表后重新操作。");
  }
  return json({
    ok: true,
    deleted: true,
    schoolKey: job.school_key,
    schoolName: result.schoolName ?? job.school_name,
    deletedReviewJobs: result.deletedReviewJobs,
  });
}

async function deleteReviewBatch(
  request: Request,
  env: EdpReviewApiEnv,
  userId: string,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  const body = await readJson(request);
  if (!Array.isArray(body.jobIds)) {
    throw new EdpReviewApiError(400, "invalid_job_ids", "请选择需要删除的审核任务。");
  }
  const jobIds = [...new Set(body.jobIds.map((value) => {
    if (typeof value !== "string" || !value.trim() || value.length > 100) {
      throw new EdpReviewApiError(400, "invalid_job_ids", "审核任务编号格式不正确。");
    }
    return value.trim();
  }))];
  if (!jobIds.length || jobIds.length > 100) {
    throw new EdpReviewApiError(400, "invalid_job_ids", "每次请选择 1 至 100 条审核任务。");
  }
  const deleted: Array<{ jobId: string; schoolKey: string; schoolName: string; deletedReviewJobs: number }> = [];
  const failures: Array<{ jobId: string; schoolName: string; message: string }> = [];
  for (const jobId of jobIds) {
    const job = await reviewJobRow(env.DB, userId, jobId);
    if (!job) {
      failures.push({ jobId, schoolName: "未知学校", message: "审核任务已不存在，请刷新列表。" });
      continue;
    }
    try {
      const result = await deleteReviewJobAndArtifacts(env, userId, job);
      if (!result.deleted) {
        failures.push({ jobId, schoolName: job.school_name, message: "该校 EDP 已更新，未删除新提交的文件。" });
      } else {
        deleted.push({ jobId, schoolKey: job.school_key, schoolName: result.schoolName ?? job.school_name, deletedReviewJobs: result.deletedReviewJobs });
      }
    } catch (error) {
      console.error("Could not delete EDP review job", { jobId, error });
      failures.push({ jobId, schoolName: job.school_name, message: "删除失败，请重试。" });
    }
  }
  return json({ ok: true, deletedCount: deleted.length, deleted, failures });
}

function decodedPathPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new EdpReviewApiError(400, "invalid_path", "审核任务地址格式不正确。");
  }
}

export async function handleEdpReviewApi(
  request: Request,
  env: EdpReviewApiEnv,
  userId: string,
  url: URL,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/edp-reviews")) return null;
  try {
    if (url.pathname === "/api/edp-reviews/settings") return await updateSettings(request, env, userId);
    if (url.pathname === "/api/edp-reviews/enqueue") return await enqueueReviews(request, env, userId);
    if (url.pathname === "/api/edp-reviews/process-next") {
      if (request.method !== "POST") return methodNotAllowed(["POST"]);
      return json({ok:true,...await processNextEdpReview(env,userId)});
    }
    if (url.pathname === "/api/edp-reviews/sync") {
      if (request.method !== "POST") return methodNotAllowed(["POST"]);
      return json({ ok: true, summary: await syncMissingEdpReviewJobs(env, userId) });
    }
    if (url.pathname === "/api/edp-reviews/export-batch" || url.pathname === "/api/edp-reviews/audit-export") {
      return await auditAndExportReviews(request, env, userId);
    }
    if (url.pathname === "/api/edp-reviews/delete-batch") {
      return await deleteReviewBatch(request, env, userId);
    }
    if (url.pathname === "/api/edp-reviews") return await listReviews(request, env, userId);
    const run = url.pathname.match(/^\/api\/edp-reviews\/([^/]+)\/run$/u);
    if (run) return await runReview(request, env, userId, decodedPathPart(run[1]));
    const recheck = url.pathname.match(/^\/api\/edp-reviews\/([^/]+)\/recheck-latest$/u);
    if (recheck) return await recheckWithLatestRule(request, env, userId, decodedPathPart(recheck[1]));
    const item = url.pathname.match(/^\/api\/edp-reviews\/([^/]+)\/items\/([^/]+)$/u);
    if (item) return await updateReviewItem(
      request,
      env,
      userId,
      decodedPathPart(item[1]),
      decodedPathPart(item[2]),
    );
    const finalize = url.pathname.match(/^\/api\/edp-reviews\/([^/]+)\/finalize$/u);
    if (finalize) return await finalizeReview(request, env, userId, decodedPathPart(finalize[1]));
    const exportDownload = url.pathname.match(/^\/api\/edp-reviews\/([^/]+)\/exports\/(draft|final)\/download$/u);
    if (exportDownload) return await downloadReviewExport(
      request,
      env,
      userId,
      decodedPathPart(exportDownload[1]),
      exportDownload[2] as "draft" | "final",
    );
    const reviewExport = url.pathname.match(/^\/api\/edp-reviews\/([^/]+)\/exports\/(draft|final)$/u);
    if (reviewExport) return await exportReview(
      request,
      env,
      userId,
      decodedPathPart(reviewExport[1]),
      reviewExport[2] as "draft" | "final",
    );
    const detail = url.pathname.match(/^\/api\/edp-reviews\/([^/]+)$/u);
    if (detail) {
      const jobId = decodedPathPart(detail[1]);
      return request.method === "DELETE"
        ? await deleteReviewSubmission(request, env, userId, jobId)
        : await getReview(request, env, userId, jobId);
    }
    return json({ ok: false, error: { code: "api_not_found", message: "未找到该 EDP 审核接口。" } }, 404);
  } catch (error) {
    return apiError(error);
  }
}
