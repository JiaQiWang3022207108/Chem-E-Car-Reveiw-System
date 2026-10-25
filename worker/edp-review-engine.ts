import {
  auditBilingualObjectiveConsistency,
  auditDetailedEdpDocuments,
  auditEdpCover,
  EDP_DETAILED_RULE_IDS,
  extractEdpWorkbookIdentity,
  type RegistrationReference,
  type EdpWorkbookIdentity,
} from "./edp-detailed-audit";
import {
  auditCrossDocumentEdp,
  EDP_CROSS_DOCUMENT_RULE_IDS,
} from "./edp-cross-document-audit";
import {
  EDP_REVIEW_RULES,
  EDP_REVIEW_RULE_VERSION,
  resolveEdpReviewRule,
  type EdpDocumentRole,
  type EdpReviewDocument,
  type EdpReviewEvidence,
  type EdpPageVisualSignal,
  type EdpReviewStatus,
} from "./edp-review-rules";
import { EdpArchiveError } from "./edp-archive-core";
import { inspectEdpPackage, type EdpSubmissionRound } from "./edp-package";
import { loadPdfJs } from "./pdf-runtime";
import { nativeReviewStatus, compareMetric } from "./native-core";

export type { EdpSubmissionRound } from "./edp-package";

export const EDP_AUDIT_RULE_IDS = Object.freeze([
  ...new Set([
    ...EDP_REVIEW_RULES.map(({ id }) => id),
    ...EDP_DETAILED_RULE_IDS,
    ...EDP_CROSS_DOCUMENT_RULE_IDS,
  ]),
]);

export type EdpOverallReviewStatus = "passed" | "failed" | "needs_human";

export interface EdpAuditItem {
  ruleId: string;
  row: number;
  status: EdpReviewStatus;
  isBlocking: boolean;
  ruleSource: string;
  worksheetName?: "1) EDP Cover Page" | "2) EDP Evaluation";
  suggestedComment: string;
  evidence: EdpReviewEvidence[];
}

export interface EdpAuditResult {
  ruleVersion: string;
  submissionRound: EdpSubmissionRound;
  documents: EdpReviewDocument[];
  workbookIdentity: EdpWorkbookIdentity;
  items: EdpAuditItem[];
  overallStatus: EdpOverallReviewStatus;
  warnings: string[];
}

export type EdpDocumentExtractor = (
  filename: string,
  bytes: Uint8Array,
  role: EdpDocumentRole,
) => Promise<EdpReviewDocument>;

export interface EdpAuditContext {
  archiveFilename: string;
  submissionRound: EdpSubmissionRound;
  competitionYear?: string;
  extractDocument?: EdpDocumentExtractor;
  registrationReference?: RegistrationReference | null;
  prohibitRecentReactionReuse?: boolean;
  currentPowerEquation?: string | null;
  ruleVersion?: string;
  annualRuleFacts?: readonly AnnualRuleFactForReview[];
}

export type EdpAuditArchiveErrorCode =
  | "invalid_archive"
  | "unsafe_archive_path"
  | "archive_too_large"
  | "unsupported_archive_entry"
  | "invalid_pdf"
  | "unclassified_document"
  | "duplicate_document_role"
  | "missing_document_role"
  | "package_invalid";

export class EdpAuditArchiveError extends Error {
  constructor(
    public readonly code: EdpAuditArchiveErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EdpAuditArchiveError";
  }
}

function normalizePageText(items: readonly unknown[]): string {
  return items
    .map((item) => {
      if (!item || typeof item !== "object" || !("str" in item)) return "";
      return typeof item.str === "string" ? item.str : "";
    })
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
}

type PdfOperatorMap = Record<string, number | undefined>;

export function summarizePdfPageSignals(
  operatorFunctions: readonly number[],
  operators: PdfOperatorMap,
  annotations: readonly unknown[],
): EdpPageVisualSignal {
  const imageOperatorIds = new Set([
    operators.paintImageXObject,
    operators.paintImageXObjectRepeat,
    operators.paintInlineImageXObject,
    operators.paintImageMaskXObject,
  ].filter((value): value is number => typeof value === "number"));
  const pathOperatorId = operators.constructPath;
  return {
    imageCount: operatorFunctions.filter((operator) => imageOperatorIds.has(operator)).length,
    pathPaintCount: typeof pathOperatorId === "number"
      ? operatorFunctions.filter((operator) => operator === pathOperatorId).length
      : 0,
    annotationCount: annotations.length,
  };
}

export async function extractPdfReviewDocument(
  filename: string,
  bytes: Uint8Array,
  role: EdpDocumentRole,
): Promise<EdpReviewDocument> {
  const pdfjs = await loadPdfJs();
  const loadingTask = pdfjs.getDocument({
    data: bytes,
    useSystemFonts: true,
    // Large scanned images used to allocate hundreds of MB only to count
    // drawing operators. Text extraction is unaffected by this image cap.
    maxImageSize: 1_000_000,
    canvasMaxAreaInBytes: 4_000_000,
    isOffscreenCanvasSupported: false,
  });
  const pdf = await loadingTask.promise;
  const pages: string[] = [];
  const pageSignals: EdpPageVisualSignal[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const text = normalizePageText(content.items);
        pages.push(text);
        // Do not decode every SDS photograph to audit text. Visual signals
        // matter only on signature/layout pages, or pages with little text.
        const visualPage = text.length < 160 ||
          /sign(?:ature|ed)|certification|laboratory.{0,25}(?:layout|diagram)|签名|签字|平面图/iu.test(text);
        if (visualPage) {
          const operatorList = await page.getOperatorList();
          const annotations = await page.getAnnotations({ intent: "display" });
          pageSignals.push({...summarizePdfPageSignals(operatorList.fnArray, pdfjs.OPS as PdfOperatorMap, annotations), visualReadLimited: true});
        } else pageSignals.push({imageCount:0,pathPaintCount:0,annotationCount:0});
      } finally { page.cleanup(); }
    }
  } finally {
    await loadingTask.destroy();
  }
  const characterCount = pages.join("").replace(/\s+/gu, "").length;
  const textQuality: EdpReviewDocument["textQuality"] = characterCount === 0
    ? "empty"
    : characterCount < 120 ? "low" : "usable";
  return { role, filename, pages, pageSignals, textQuality };
}

export function computeOverallReviewStatus(
  items: readonly (Pick<EdpAuditItem, "status"> & Partial<Pick<EdpAuditItem, "isBlocking">>)[],
): EdpOverallReviewStatus {
  const status = nativeReviewStatus(
    items.filter(item => item.status === "no").length,
    items.filter(item => item.status === "needs_human" && item.isBlocking !== false).length,
    items.length);
  return (["passed","failed","needs_human"] as const)[status];
}

export interface AnnualRuleFactForReview {
  factId: string;
  category: string;
  normalizedRequirement: string;
  operator: "lt" | "lte" | "eq" | "gte" | "gt" | "must" | "must_not" | "may" | "conditional";
  value: string | null;
  unit: string | null;
  page: number;
  excerpt: string;
  confidence: "high" | "medium" | "low";
  confirmationStatus: "pending" | "confirmed" | "rejected";
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function annualMetricPattern(fact: AnnualRuleFactForReview): RegExp | null {
  if (!fact.unit) return null;
  const unit = regexEscape(fact.unit);
  if (/(?:最大操作压力|\bMOP\b)/iu.test(fact.normalizedRequirement)) {
    return new RegExp(`(?:最大操作压力|\\bMOP\\b)[^\\d]{0,48}([+-]?\\d+(?:[.,]\\d+)?)\\s*${unit}`, "iu");
  }
  if (/(?:现场|原位).{0,16}(?:制氢|氢气)|on-?site.{0,20}hydrogen/iu.test(fact.normalizedRequirement)) {
    return new RegExp(`(?:现场|原位|on-?site)[^\\d]{0,80}([+-]?\\d+(?:[.,]\\d+)?)\\s*${unit}`, "iu");
  }
  return null;
}

function annualComparison(operator: AnnualRuleFactForReview["operator"], actual: number, limit: number): boolean | null {
  const result = compareMetric(["lt","lte","eq","gte","gt"].indexOf(operator), actual, limit);
  return result < 0 ? null : result === 1;
}

function annualExcerpt(text: string, matchIndex: number, matchLength: number): string {
  const compact = text.replace(/\s+/gu, " ").trim();
  const start = Math.max(0, matchIndex - 80);
  const end = Math.min(compact.length, matchIndex + Math.max(matchLength, 1) + 120);
  return `${start > 0 ? "…" : ""}${compact.slice(start, end)}${end < compact.length ? "…" : ""}`.slice(0, 240);
}

export function resolveAnnualRuleFact(
  fact: AnnualRuleFactForReview,
  documents: readonly EdpReviewDocument[],
  annualRuleVersion: string,
): EdpAuditItem {
  const base = {
    ruleId: `annual:${fact.factId}`,
    row: /(?:最大操作压力|\bMOP\b)/iu.test(fact.normalizedRequirement) ? 27 : 32,
    isBlocking: true,
    ruleSource: `annual:${annualRuleVersion}:${fact.factId}`,
  };
  const needsHuman = (comment: string, evidence: EdpReviewEvidence[] = []): EdpAuditItem => ({
    ...base,
    status: "needs_human",
    suggestedComment: comment,
    evidence,
  });
  if (fact.confirmationStatus !== "confirmed") {
    return needsHuman("年度规则候选尚未由操作者确认，不能据此自动判定。");
  }
  if (fact.confidence !== "high") {
    return needsHuman("年度规则事实的自动提取置信度不足，请人工对照规则原文。");
  }
  const limit = fact.value === null ? Number.NaN : Number(fact.value.replace(",", "."));
  const pattern = annualMetricPattern(fact);
  if (!pattern || !Number.isFinite(limit)) {
    return needsHuman("该年度规则不能与 EDP 中的客观数值可靠对应，请人工核对。");
  }
  const outcomes: boolean[] = [];
  const evidence: EdpReviewEvidence[] = [];
  for (const document of documents) {
    if (document.textQuality !== "usable") continue;
    for (let pageIndex = 0; pageIndex < document.pages.length; pageIndex += 1) {
      const text = document.pages[pageIndex] ?? "";
      const match = pattern.exec(text);
      if (!match) continue;
      const actual = Number(match[1].replace(",", "."));
      const outcome = annualComparison(fact.operator, actual, limit);
      if (outcome === null || !Number.isFinite(actual)) continue;
      outcomes.push(outcome);
      evidence.push({
        documentRole: document.role,
        filename: document.filename,
        page: pageIndex + 1,
        excerpt: annualExcerpt(text, match.index, match[0].length),
      });
    }
  }
  if (outcomes.length === 0) {
    return needsHuman("未在 EDP 中定位到可与年度规则直接比较的同单位客观数值。");
  }
  if (outcomes.some(Boolean) && outcomes.some((outcome) => !outcome)) {
    return needsHuman("EDP 中出现相互冲突的客观数值，请人工核对原文。", evidence);
  }
  const status: EdpReviewStatus = outcomes.every(Boolean) ? "yes" : "no";
  return {
    ...base,
    status,
    evidence,
    suggestedComment: status === "yes"
      ? `EDP 客观数值符合年度规则：${fact.normalizedRequirement}`
      : `EDP 客观数值不符合年度规则：${fact.normalizedRequirement}`,
  };
}

export async function auditEdpArchive(
  bytes: ArrayBuffer | Uint8Array,
  context: EdpAuditContext,
): Promise<EdpAuditResult> {
  const archiveBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let inspection;
  try {
    inspection = await inspectEdpPackage(archiveBytes, context.archiveFilename, context.submissionRound);
  } catch (error) {
    if (error instanceof EdpArchiveError) {
      const code: EdpAuditArchiveErrorCode = error.code === "unsafe_archive_path"
        ? "unsafe_archive_path"
        : error.code === "archive_too_large"
          ? "archive_too_large"
          : "invalid_archive";
      throw new EdpAuditArchiveError(code, error.message);
    }
    throw new EdpAuditArchiveError(
      "invalid_archive",
      error instanceof Error ? error.message : "压缩包损坏或无法读取。",
    );
  }
  if (!inspection.qualified) {
    throw new EdpAuditArchiveError(
      "package_invalid",
      inspection.reasons.join(" ") || "EDP 压缩包的文件数量、格式或用途不符合当前提交轮次。",
    );
  }

  const documents: EdpReviewDocument[] = [];
  const warnings: string[] = [];
  const extractDocument = context.extractDocument ?? extractPdfReviewDocument;

  // Release each PDF buffer after parsing; retain only text/evidence.
  while (inspection.documents.length) {
    const packageDocument = inspection.documents.shift()!;
    const filename = packageDocument.displayPath;
    const role = packageDocument.role;
    let document: EdpReviewDocument;
    try {
      document = await extractDocument(filename, packageDocument.bytes, role);
    } catch {
      document = { role, filename, pages: [], textQuality: "empty" };
      warnings.push(`${filename} 的文字提取失败，需要人工查看原 PDF。`);
    }
    if (document.role !== role || document.filename !== filename) {
      document = { ...document, role, filename };
    }
    if (document.textQuality !== "usable") {
      warnings.push(`${filename} 无法可靠提取文字，需要人工查看原 PDF。`);
    }
    documents.push(document);
  }

  const items: EdpAuditItem[] = EDP_REVIEW_RULES.map((rule) => {
    if (rule.id === "moc" && context.submissionRound === 1) {
      return {
        ruleId: rule.id,
        row: rule.row,
        status: "not_applicable" as const,
        isBlocking: rule.isBlocking,
        ruleSource: rule.ruleSource,
        suggestedComment: "第1次 EDP 提交不要求 MOC 文件。",
        evidence: [],
      };
    }
    return resolveEdpReviewRule(rule, documents);
  });
  items.push(
    ...auditEdpCover(documents, context.registrationReference ?? null),
    auditBilingualObjectiveConsistency(documents),
    ...auditDetailedEdpDocuments(documents, {
      registrationReference: context.registrationReference,
      prohibitRecentReactionReuse: context.prohibitRecentReactionReuse ?? true,
      currentPowerEquation: context.currentPowerEquation,
    }),
  );
  const strictItems = auditCrossDocumentEdp(documents, {
    submissionRound: context.submissionRound,
    competitionYear: context.competitionYear,
  });
  const strictRuleIds = new Set<string>(strictItems.map(({ ruleId }) => ruleId));
  const retainedItems = items.filter(({ ruleId }) => !strictRuleIds.has(ruleId));
  items.length = 0;
  items.push(...retainedItems, ...strictItems);
  if (context.ruleVersion && context.ruleVersion !== EDP_REVIEW_RULE_VERSION) {
    items.push(...(context.annualRuleFacts ?? [])
      .filter(({ confirmationStatus }) => confirmationStatus !== "rejected")
      .map((fact) => resolveAnnualRuleFact(fact, documents, context.ruleVersion!)));
  }

  return {
    ruleVersion: context.ruleVersion ?? EDP_REVIEW_RULE_VERSION,
    submissionRound: context.submissionRound,
    documents,
    workbookIdentity: extractEdpWorkbookIdentity(documents),
    items,
    overallStatus: computeOverallReviewStatus(items),
    warnings: [...new Set(warnings)],
  };
}
