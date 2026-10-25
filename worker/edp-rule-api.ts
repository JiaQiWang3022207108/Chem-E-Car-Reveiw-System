import { EDP_REVIEW_RULE_VERSION } from "./edp-review-rules";
import {
  EdpRulePdfError,
  parseEdpRulePdf,
  sha256Hex,
  validateEdpRulePdfEnvelope,
  type EdpRuleFactCategory,
  type EdpRuleFactOperator,
} from "./edp-rule-parser";

interface EdpRuleApiEnv {
  DB: D1Database;
  FILES: R2Bucket;
}

interface RuleDocumentRow {
  document_id: string;
  applicable_year: number;
  entered_year: number;
  detected_year: number | null;
  filename: string;
  r2_key: string;
  sha256: string;
  size: number;
  status: "processing" | "needs_confirmation" | "active" | "archived" | "failed";
  parse_warnings_json: string;
  parse_error: string | null;
  builtin_rule_version: string;
  rule_version: string;
  year_conflict_confirmed: number;
  confirmed_at: string | null;
  activated_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  fact_count?: number;
}

interface RuleFactRow {
  fact_id: string;
  category: EdpRuleFactCategory;
  section: string;
  normalized_requirement: string;
  operator: EdpRuleFactOperator;
  structured_value: string | null;
  structured_unit: string | null;
  condition_text: string | null;
  source_page: number;
  evidence_excerpt: string;
  confidence: "high" | "medium" | "low";
  confirmation_status: "pending" | "confirmed" | "rejected";
}

class EdpRuleApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EdpRuleApiError";
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
  return json({
    ok: false,
    error: { code: "method_not_allowed", message: `此接口仅支持 ${allowed.join("、")} 请求。` },
  }, 405, { Allow: allowed.join(", ") });
}

function errorResponse(error: unknown): Response {
  if (error instanceof EdpRuleApiError) {
    return json({ ok: false, error: { code: error.code, message: error.message } }, error.status);
  }
  if (error instanceof EdpRulePdfError) {
    const status = error.code === "rule_pdf_too_large" ? 413 : error.code === "invalid_pdf_header" ? 415 : 422;
    return json({ ok: false, error: { code: error.code, message: error.message } }, status);
  }
  console.error("EDP annual rule API failed", error);
  return json({
    ok: false,
    error: { code: "edp_rule_api_failed", message: "年度竞赛规则暂时无法处理，请稍后重试。" },
  }, 500);
}

function safeJsonArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function documentFromRow(row: RuleDocumentRow) {
  return {
    documentId: row.document_id,
    applicableYear: row.applicable_year,
    enteredYear: row.entered_year,
    detectedYear: row.detected_year,
    filename: row.filename,
    r2Key: row.r2_key,
    sha256: row.sha256,
    size: row.size,
    status: row.status,
    warnings: safeJsonArray(row.parse_warnings_json),
    parseError: row.parse_error,
    builtinRuleVersion: row.builtin_rule_version,
    ruleVersion: row.rule_version,
    yearConflict: row.detected_year !== null && row.detected_year !== row.applicable_year,
    yearConflictConfirmed: Boolean(row.year_conflict_confirmed),
    factCount: Number(row.fact_count ?? 0),
    confirmedAt: row.confirmed_at,
    activatedAt: row.activated_at,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    downloadUrl: `/api/edp-rule-documents/${encodeURIComponent(row.document_id)}/download`,
  };
}

function factFromRow(row: RuleFactRow) {
  return {
    factId: row.fact_id,
    category: row.category,
    section: row.section,
    normalizedRequirement: row.normalized_requirement,
    operator: row.operator,
    value: row.structured_value,
    unit: row.structured_unit,
    condition: row.condition_text,
    page: row.source_page,
    excerpt: row.evidence_excerpt,
    confidence: row.confidence,
    confirmationStatus: row.confirmation_status,
  };
}

function decodedPathPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new EdpRuleApiError(400, "invalid_rule_path", "年度规则地址格式不正确。");
  }
}

async function getDocumentRow(
  db: D1Database,
  userId: string,
  documentId: string,
): Promise<RuleDocumentRow> {
  const row = await db.prepare(`SELECT d.*,
    (SELECT COUNT(*) FROM edp_rule_facts f WHERE f.user_id = d.user_id AND f.document_id = d.document_id) AS fact_count
    FROM edp_rule_documents d WHERE d.user_id = ? AND d.document_id = ?`)
    .bind(userId, documentId).first<RuleDocumentRow>();
  if (!row) throw new EdpRuleApiError(404, "rule_document_not_found", "未找到该年度竞赛规则版本。");
  return row;
}

async function listDocuments(
  request: Request,
  env: EdpRuleApiEnv,
  userId: string,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(["GET", "POST"]);
  const rows = await env.DB.prepare(`SELECT d.*,
    (SELECT COUNT(*) FROM edp_rule_facts f WHERE f.user_id = d.user_id AND f.document_id = d.document_id) AS fact_count
    FROM edp_rule_documents d WHERE d.user_id = ?
    ORDER BY d.applicable_year DESC, d.created_at DESC, d.document_id DESC`)
    .bind(userId).all<RuleDocumentRow>();
  const documents = (rows.results ?? []).map(documentFromRow);
  const activeByYear: Record<string, ReturnType<typeof documentFromRow>> = {};
  for (const document of documents) {
    if (document.status === "active") activeByYear[String(document.applicableYear)] = document;
  }
  return json({ ok: true, documents, activeByYear });
}

function validUploadFile(value: FormDataEntryValue | null): value is File {
  return value instanceof Blob && "name" in value && typeof value.name === "string";
}

function safeFilename(value: string): string {
  const normalized = [...value.normalize("NFKC")]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127;
    })
    .join("")
    .trim();
  const basename = normalized.split(/[\\/]/u).at(-1) ?? "竞赛规则.pdf";
  return basename.slice(0, 180) || "竞赛规则.pdf";
}

function readUploadYear(value: FormDataEntryValue | null): number {
  if (typeof value !== "string" || !/^20\d{2}$/u.test(value.trim())) {
    throw new EdpRuleApiError(400, "invalid_rule_year", "请先选择四位适用年份。");
  }
  const year = Number(value);
  if (year < 2000 || year > 2200) {
    throw new EdpRuleApiError(400, "invalid_rule_year", "适用年份必须是 2000 至 2200 之间的四位年份。");
  }
  return year;
}

async function insertFacts(
  env: EdpRuleApiEnv,
  userId: string,
  documentId: string,
  facts: Awaited<ReturnType<typeof parseEdpRulePdf>>["facts"],
  timestamp: string,
): Promise<void> {
  for (let offset = 0; offset < facts.length; offset += 80) {
    const statements = facts.slice(offset, offset + 80).map((fact) => env.DB.prepare(`INSERT INTO edp_rule_facts (
      user_id, document_id, fact_id, category, section, normalized_requirement,
      operator, structured_value, structured_unit, condition_text, source_page,
      evidence_excerpt, confidence, confirmation_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .bind(
        userId,
        documentId,
        fact.factId,
        fact.category,
        fact.section,
        fact.normalizedRequirement,
        fact.operator,
        fact.value,
        fact.unit,
        fact.condition,
        fact.page,
        fact.excerpt,
        fact.confidence,
        timestamp,
        timestamp,
      ));
    if (statements.length > 0) await env.DB.batch(statements);
  }
}

async function uploadDocument(
  request: Request,
  env: EdpRuleApiEnv,
  userId: string,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["GET", "POST"]);
  if (!request.headers.get("Content-Type")?.toLowerCase().includes("multipart/form-data")) {
    throw new EdpRuleApiError(415, "unsupported_media_type", "请以表单方式上传年度竞赛规则 PDF。");
  }
  const form = await request.formData();
  const applicableYear = readUploadYear(form.get("year"));
  const file = form.get("file");
  if (!validUploadFile(file)) throw new EdpRuleApiError(400, "rule_file_required", "请选择年度竞赛规则 PDF。");
  const filename = safeFilename(file.name);
  if (!/\.pdf$/iu.test(filename)) throw new EdpRuleApiError(415, "rule_file_must_be_pdf", "年度竞赛规则只接受 PDF 文件。");
  const bytes = new Uint8Array(await file.arrayBuffer());
  validateEdpRulePdfEnvelope(bytes, file.size);
  const sha256 = await sha256Hex(bytes);
  const duplicate = await env.DB.prepare(`SELECT d.*,
    (SELECT COUNT(*) FROM edp_rule_facts f WHERE f.user_id = d.user_id AND f.document_id = d.document_id) AS fact_count
    FROM edp_rule_documents d WHERE d.user_id = ? AND d.applicable_year = ? AND d.sha256 = ?`)
    .bind(userId, applicableYear, sha256).first<RuleDocumentRow>();
  if (duplicate) return json({ ok: true, duplicate: true, document: documentFromRow(duplicate) });

  const documentId = crypto.randomUUID();
  const now = new Date().toISOString();
  const ruleVersion = `${applicableYear}-${sha256.slice(0, 16)}-${EDP_REVIEW_RULE_VERSION}`;
  const r2Key = `edp-rules/${encodeURIComponent(userId)}/${applicableYear}/${documentId}.pdf`;
  await env.DB.prepare(`INSERT INTO edp_rule_documents (
    user_id, document_id, applicable_year, entered_year, detected_year, filename,
    r2_key, sha256, size, status, parse_warnings_json, parse_error,
    builtin_rule_version, rule_version, year_conflict_confirmed, created_at, updated_at
  ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, 'processing', '[]', NULL, ?, ?, 0, ?, ?)`)
    .bind(
      userId,
      documentId,
      applicableYear,
      applicableYear,
      filename,
      r2Key,
      sha256,
      bytes.byteLength,
      EDP_REVIEW_RULE_VERSION,
      ruleVersion,
      now,
      now,
    ).run();
  try {
    await env.FILES.put(r2Key, bytes, {
      httpMetadata: { contentType: "application/pdf" },
      customMetadata: {
        originalFilename: filename,
        applicableYear: String(applicableYear),
        documentId,
        sha256,
      },
    });
    const parsed = await parseEdpRulePdf({ bytes, enteredYear: applicableYear, builtinRuleVersion: EDP_REVIEW_RULE_VERSION });
    await insertFacts(env, userId, documentId, parsed.facts, now);
    await env.DB.prepare(`UPDATE edp_rule_documents SET detected_year = ?, status = 'needs_confirmation',
      parse_warnings_json = ?, parse_error = NULL, rule_version = ?, updated_at = ?
      WHERE user_id = ? AND document_id = ?`)
      .bind(parsed.detectedYear, JSON.stringify(parsed.warnings), parsed.version, now, userId, documentId).run();
    const stored = await getDocumentRow(env.DB, userId, documentId);
    return json({ ok: true, duplicate: false, document: documentFromRow(stored) }, 201);
  } catch (error) {
    const code = error instanceof EdpRulePdfError ? error.code : "rule_pdf_processing_failed";
    const message = error instanceof Error ? error.message : "竞赛规则 PDF 解析失败。";
    await env.DB.prepare(`UPDATE edp_rule_documents SET status = 'failed', parse_error = ?,
      parse_warnings_json = ?, updated_at = ? WHERE user_id = ? AND document_id = ?`)
      .bind(message, JSON.stringify([message]), new Date().toISOString(), userId, documentId).run();
    const failed = await getDocumentRow(env.DB, userId, documentId);
    return json({
      ok: false,
      error: { code, message },
      document: documentFromRow(failed),
    }, error instanceof EdpRulePdfError ? 422 : 500);
  }
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("Content-Type")?.toLowerCase().includes("application/json")) {
    throw new EdpRuleApiError(415, "unsupported_media_type", "请以 JSON 格式提交确认信息。");
  }
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid object");
    return body as Record<string, unknown>;
  } catch {
    throw new EdpRuleApiError(400, "invalid_json", "确认信息不是有效的 JSON 对象。");
  }
}

async function getDocument(
  request: Request,
  env: EdpRuleApiEnv,
  userId: string,
  documentId: string,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(["GET", "DELETE"]);
  const document = await getDocumentRow(env.DB, userId, documentId);
  const factsResult = await env.DB.prepare(`SELECT fact_id, category, section, normalized_requirement,
    operator, structured_value, structured_unit, condition_text, source_page, evidence_excerpt,
    confidence, confirmation_status FROM edp_rule_facts
    WHERE user_id = ? AND document_id = ? ORDER BY source_page, fact_id`)
    .bind(userId, documentId).all<RuleFactRow>();
  const facts = (factsResult.results ?? []).map(factFromRow);
  const baseline = await env.DB.prepare(`SELECT document_id FROM edp_rule_documents
    WHERE user_id = ? AND applicable_year = ? AND document_id <> ?
      AND status = CASE WHEN ? = 'active' THEN 'archived' ELSE 'active' END
    ORDER BY COALESCE(activated_at, archived_at, created_at) DESC LIMIT 1`)
    .bind(userId, document.applicable_year, documentId, document.status).first<{ document_id: string }>();
  let baselineFacts: ReturnType<typeof factFromRow>[] = [];
  if (baseline) {
    const rows = await env.DB.prepare(`SELECT fact_id, category, section, normalized_requirement,
      operator, structured_value, structured_unit, condition_text, source_page, evidence_excerpt,
      confidence, confirmation_status FROM edp_rule_facts
      WHERE user_id = ? AND document_id = ? ORDER BY source_page, fact_id`)
      .bind(userId, baseline.document_id).all<RuleFactRow>();
    baselineFacts = (rows.results ?? []).map(factFromRow);
  }
  const signature = (fact: ReturnType<typeof factFromRow>) => `${fact.category}|${fact.normalizedRequirement}`;
  const baselineMap = new Map(baselineFacts.map((fact) => [signature(fact), fact]));
  const currentMap = new Map(facts.map((fact) => [signature(fact), fact]));
  const added = facts.filter((fact) => !baselineMap.has(signature(fact))).map(({ factId }) => factId);
  const removed = baselineFacts.filter((fact) => !currentMap.has(signature(fact))).map(({ factId }) => factId);
  const changed = facts.filter((fact) => {
    const previous = baselineMap.get(signature(fact));
    return previous && (
      previous.operator !== fact.operator
      || previous.value !== fact.value
      || previous.unit !== fact.unit
      || previous.condition !== fact.condition
    );
  }).map(({ factId }) => factId);
  return json({
    ok: true,
    document: documentFromRow(document),
    facts,
    changes: { added, removed, changed },
    comparedWithDocumentId: baseline?.document_id ?? null,
  });
}

async function activateDocument(
  request: Request,
  env: EdpRuleApiEnv,
  userId: string,
  documentId: string,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  const body = await readJsonObject(request);
  const document = await getDocumentRow(env.DB, userId, documentId);
  if (document.status === "active") return json({ ok: true, document: documentFromRow(document) });
  if (document.status !== "needs_confirmation") {
    throw new EdpRuleApiError(409, "rule_document_not_activatable", "只有解析完成、等待确认的规则版本可以启用。");
  }
  const hasYearConflict = document.detected_year !== null && document.detected_year !== document.applicable_year;
  if (hasYearConflict && body.confirmYearConflict !== true) {
    throw new EdpRuleApiError(
      409,
      "rule_year_conflict_confirmation_required",
      `填写年份 ${document.applicable_year} 与正文检测年份 ${document.detected_year} 不一致，请明确确认后再启用。`,
    );
  }
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE edp_rule_documents SET status = 'archived', archived_at = ?, updated_at = ?
      WHERE user_id = ? AND applicable_year = ? AND status = 'active' AND document_id <> ?`)
      .bind(now, now, userId, document.applicable_year, documentId),
    env.DB.prepare(`UPDATE edp_rule_documents SET status = 'active', year_conflict_confirmed = ?,
      confirmed_at = COALESCE(confirmed_at, ?), activated_at = ?, archived_at = NULL, updated_at = ?
      WHERE user_id = ? AND document_id = ? AND status = 'needs_confirmation'`)
      .bind(hasYearConflict ? 1 : 0, now, now, now, userId, documentId),
    env.DB.prepare(`UPDATE edp_rule_facts SET confirmation_status = 'confirmed', updated_at = ?
      WHERE user_id = ? AND document_id = ? AND confirmation_status = 'pending'`)
      .bind(now, userId, documentId),
    env.DB.prepare(`INSERT INTO edp_review_settings (
      user_id, active_rule_document_id, active_rule_version, updated_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      active_rule_document_id = excluded.active_rule_document_id,
      active_rule_version = excluded.active_rule_version,
      updated_at = excluded.updated_at`)
      .bind(userId, documentId, document.rule_version, now),
  ]);
  const active = await getDocumentRow(env.DB, userId, documentId);
  if (active.status !== "active") {
    throw new EdpRuleApiError(409, "rule_activation_conflict", "该规则版本未能启用，可能已被其他操作更新。");
  }
  return json({ ok: true, document: documentFromRow(active) });
}

function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/gu, "_").replace(/["\\]/gu, "_") || "competition-rules.pdf";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function downloadDocument(
  request: Request,
  env: EdpRuleApiEnv,
  userId: string,
  documentId: string,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  const document = await getDocumentRow(env.DB, userId, documentId);
  const object = await env.FILES.get(document.r2_key);
  if (!object) throw new EdpRuleApiError(404, "rule_pdf_missing", "规则记录存在，但原 PDF 已从云端丢失。");
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", "application/pdf");
  headers.set("Content-Disposition", contentDisposition(document.filename));
  headers.set("Content-Length", String(object.size));
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(object.body, { headers });
}

async function deleteDocument(
  request: Request,
  env: EdpRuleApiEnv,
  userId: string,
  documentId: string,
): Promise<Response> {
  if (request.method !== "DELETE") return methodNotAllowed(["GET", "DELETE"]);
  const document = await getDocumentRow(env.DB, userId, documentId);
  if (document.status === "active") {
    throw new EdpRuleApiError(409, "active_rule_cannot_be_deleted", "正在启用的年度规则不能删除，只能由同年新版本替代并归档。");
  }
  if (document.status === "archived") {
    throw new EdpRuleApiError(409, "archived_rule_cannot_be_deleted", "已归档规则用于历史审核追溯，不能删除。");
  }
  const reference = await env.DB.prepare(`SELECT COUNT(*) AS total FROM edp_review_jobs
    WHERE user_id = ? AND rule_version = ?`).bind(userId, document.rule_version).first<{ total: number }>();
  if (Number(reference?.total ?? 0) > 0) {
    throw new EdpRuleApiError(409, "referenced_rule_cannot_be_deleted", "该规则版本已被审核任务引用，不能删除。");
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM edp_rule_facts WHERE user_id = ? AND document_id = ?").bind(userId, documentId),
    env.DB.prepare("DELETE FROM edp_rule_documents WHERE user_id = ? AND document_id = ?").bind(userId, documentId),
  ]);
  await env.FILES.delete(document.r2_key);
  return json({ ok: true, deleted: true, documentId });
}

export async function handleEdpRuleDocumentApi(
  request: Request,
  env: EdpRuleApiEnv,
  userId: string,
  url: URL,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/edp-rule-documents")) return null;
  try {
    if (url.pathname === "/api/edp-rule-documents") {
      return request.method === "POST"
        ? await uploadDocument(request, env, userId)
        : await listDocuments(request, env, userId);
    }
    const activate = url.pathname.match(/^\/api\/edp-rule-documents\/([^/]+)\/activate$/u);
    if (activate) return await activateDocument(request, env, userId, decodedPathPart(activate[1]));
    const download = url.pathname.match(/^\/api\/edp-rule-documents\/([^/]+)\/download$/u);
    if (download) return await downloadDocument(request, env, userId, decodedPathPart(download[1]));
    const detail = url.pathname.match(/^\/api\/edp-rule-documents\/([^/]+)$/u);
    if (detail) {
      const documentId = decodedPathPart(detail[1]);
      return request.method === "DELETE"
        ? await deleteDocument(request, env, userId, documentId)
        : await getDocument(request, env, userId, documentId);
    }
    return json({ ok: false, error: { code: "api_not_found", message: "未找到该年度规则接口。" } }, 404);
  } catch (error) {
    return errorResponse(error);
  }
}
