import { loadPdfJs } from "./pdf-runtime";

export const MAX_EDP_RULE_PDF_BYTES = 50 * 1024 * 1024;

export type EdpRuleDocumentStatus =
  | "processing"
  | "needs_confirmation"
  | "active"
  | "archived"
  | "failed";

export type EdpRuleFactCategory =
  | "numeric_limit"
  | "required"
  | "prohibited"
  | "allowed"
  | "conditional";

export type EdpRuleFactOperator =
  | "lt"
  | "lte"
  | "eq"
  | "gte"
  | "gt"
  | "must"
  | "must_not"
  | "may"
  | "conditional";

export interface EdpRuleFactCandidate {
  factId: string;
  category: EdpRuleFactCategory;
  section: string;
  normalizedRequirement: string;
  operator: EdpRuleFactOperator;
  value: string | null;
  unit: string | null;
  condition: string | null;
  page: number;
  excerpt: string;
  confidence: "high" | "medium" | "low";
}

export interface EdpRuleParseResult {
  detectedYear: number | null;
  warnings: string[];
  yearConflict: boolean;
  version: string;
  facts: EdpRuleFactCandidate[];
}

export interface ParseEdpRuleTextPagesInput {
  pages: readonly string[];
  enteredYear: number;
  sha256: string;
  builtinRuleVersion: string;
}

export class EdpRulePdfError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "EdpRulePdfError";
    this.code = code;
  }
}

function hasPdfHeader(bytes: Uint8Array): boolean {
  return bytes.length >= 5
    && bytes[0] === 0x25
    && bytes[1] === 0x50
    && bytes[2] === 0x44
    && bytes[3] === 0x46
    && bytes[4] === 0x2d;
}

export function validateEdpRulePdfEnvelope(
  bytes: Uint8Array,
  declaredSize = bytes.byteLength,
): void {
  if (!Number.isSafeInteger(declaredSize) || declaredSize <= 0) {
    throw new EdpRulePdfError("invalid_rule_pdf_size", "竞赛规则 PDF 文件大小无效。");
  }
  if (declaredSize > MAX_EDP_RULE_PDF_BYTES || bytes.byteLength > MAX_EDP_RULE_PDF_BYTES) {
    throw new EdpRulePdfError("rule_pdf_too_large", "竞赛规则 PDF 不能超过 50MB。");
  }
  if (!hasPdfHeader(bytes)) {
    throw new EdpRulePdfError("invalid_pdf_header", "文件扩展名虽为 PDF，但文件头不是有效的 %PDF-。");
  }
}

export function classifyPdfLoadFailure(error: unknown): "encrypted_pdf" | "invalid_pdf" {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /password|encrypted|encryption|口令|密码/iu.test(message) ? "encrypted_pdf" : "invalid_pdf";
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u00a0\u2000-\u200b\u202f\u205f\u3000]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(bytes: Uint8Array | string): Promise<string> {
  const input = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return hex(await crypto.subtle.digest("SHA-256", new Uint8Array(input)));
}

export function buildEdpRuleVersion(
  applicableYear: number,
  sha256: string,
  builtinRuleVersion: string,
): string {
  const safeBuiltinVersion = builtinRuleVersion.replace(/[^a-z0-9._-]+/giu, "-").replace(/^-+|-+$/gu, "") || "unknown";
  return `${applicableYear}-${sha256.toLowerCase().slice(0, 16)}-${safeBuiltinVersion}`;
}

interface YearCandidate {
  year: number;
  score: number;
  count: number;
}

function detectRuleYear(pages: readonly string[]): { detectedYear: number | null; secondaryYears: number[] } {
  const candidates = new Map<number, YearCandidate>();
  pages.forEach((rawPage, pageIndex) => {
    const page = normalizeText(rawPage);
    for (const match of page.matchAll(/(?<!\d)(20\d{2})(?!\d)/gu)) {
      const year = Number(match[1]);
      if (year < 2000 || year > 2200) continue;
      const index = match.index ?? 0;
      const context = page.slice(Math.max(0, index - 36), Math.min(page.length, index + 44));
      let score = 1;
      if (pageIndex === 0) score += 10;
      else if (pageIndex === 1) score += 3;
      if (/(?:竞赛|比赛|规则|Chem-E-Car|Competition|Rules?)/iu.test(context)) score += 20;
      if (/(?:附录|历年|往届|上一届|previous|history|实例)/iu.test(context)) score -= 12;
      const existing = candidates.get(year) ?? { year, score: 0, count: 0 };
      existing.score += score;
      existing.count += 1;
      candidates.set(year, existing);
    }
  });
  const ranked = [...candidates.values()].sort((left, right) => (
    right.score - left.score || right.count - left.count || right.year - left.year
  ));
  return {
    detectedYear: ranked[0]?.year ?? null,
    secondaryYears: ranked.slice(1).map(({ year }) => year),
  };
}

function splitSentences(page: string): string[] {
  const normalized = page.replace(/\r\n?/gu, "\n");
  const sentences: string[] = [];
  let buffer = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    buffer += character;
    const previous = normalized[index - 1] ?? "";
    const next = normalized[index + 1] ?? "";
    const decimalPoint = (character === "." || character === "．") && /\d/u.test(previous) && /\d/u.test(next);
    if (!decimalPoint && /[。！？!?；;\n]/u.test(character)) {
      const sentence = normalizeText(buffer);
      if (sentence) sentences.push(sentence);
      buffer = "";
    }
  }
  const trailing = normalizeText(buffer);
  if (trailing) sentences.push(trailing);
  return sentences;
}

function extractSection(sentence: string, currentSection: string): string {
  const heading = sentence.match(/(?:^|\s)((?:第[一二三四五六七八九十百0-9]+[章节部分]|附录)[^。；;]{0,48})/u)?.[1];
  if (heading) return normalizeText(heading).slice(0, 80);
  return currentSection;
}

const UNIT_PATTERN = "(?:psig|psi|bar|MPa|kPa|Pa|mol\\/L|mol·L-?1|wt%|vol%|°C|℃|K|ms|min|h|s|mm|cm|mL|μL|uL|L|mg|kg|g|%|份|个|人|次)";
const NUMBER_PATTERN = "([+-]?(?:\\d+(?:[.,]\\d+)?|[.,]\\d+))";

function extractNumeric(sentence: string): { operator: Exclude<EdpRuleFactOperator, "must" | "must_not" | "may" | "conditional">; value: string; unit: string | null } | null {
  const comparisons: Array<[RegExp, "lt" | "lte" | "eq" | "gte" | "gt"]> = [
    [new RegExp(`(?:不得超过|不超过|不大于|至多|小于等于|≤|<=)\\s*${NUMBER_PATTERN}\\s*(${UNIT_PATTERN})?`, "iu"), "lte"],
    [new RegExp(`(?:不低于|不少于|至少|大于等于|≥|>=)\\s*${NUMBER_PATTERN}\\s*(${UNIT_PATTERN})?`, "iu"), "gte"],
    [new RegExp(`(?:低于|小于|<)\\s*${NUMBER_PATTERN}\\s*(${UNIT_PATTERN})?`, "iu"), "lt"],
    [new RegExp(`(?:高于|大于|超过|>)\\s*${NUMBER_PATTERN}\\s*(${UNIT_PATTERN})?`, "iu"), "gt"],
    [new RegExp(`(?:等于|为|=|提交|包含|需要)\\s*${NUMBER_PATTERN}\\s*(${UNIT_PATTERN})?`, "iu"), "eq"],
  ];
  for (const [pattern, operator] of comparisons) {
    const match = sentence.match(pattern);
    if (!match) continue;
    return {
      operator,
      value: match[1].replace(",", "."),
      unit: match[2] ?? null,
    };
  }
  return null;
}

function extractCondition(sentence: string): string | null {
  const explicit = sentence.match(/(?:仅当|只有当|如果|若|当|在)(.{1,100}?)(?:时|情况下|条件下)[，,:：]?/u)?.[1];
  return explicit ? normalizeText(explicit) : null;
}

function classifySentence(sentence: string): {
  category: EdpRuleFactCategory;
  operator: EdpRuleFactOperator;
  value: string | null;
  unit: string | null;
  condition: string | null;
  confidence: "high" | "medium" | "low";
} | null {
  const condition = extractCondition(sentence);
  const numeric = extractNumeric(sentence);
  if (condition && /(?:仅当|只有当|如果|若|当|情况下|条件下)/u.test(sentence)) {
    return {
      category: "conditional",
      operator: "conditional",
      value: numeric?.value ?? null,
      unit: numeric?.unit ?? null,
      condition,
      confidence: /(?:必须|不得|禁止|允许|应当|需要|须)/u.test(sentence) ? "high" : "medium",
    };
  }
  if (numeric) {
    return { category: "numeric_limit", ...numeric, condition: null, confidence: "high" };
  }
  if (/(?:严禁|禁止|不得使用|不得采用|不允许|不可使用)/u.test(sentence)) {
    return { category: "prohibited", operator: "must_not", value: null, unit: null, condition: null, confidence: "high" };
  }
  if (/(?:必须|应当|需要|须)(?:\s|确保|提供|填写|提交|安装|使用|说明|包含|配备)/u.test(sentence)) {
    return { category: "required", operator: "must", value: null, unit: null, condition: null, confidence: "high" };
  }
  if (/(?:允许|可以|可采用|可使用)/u.test(sentence)) {
    return { category: "allowed", operator: "may", value: null, unit: null, condition: null, confidence: "medium" };
  }
  return null;
}

export async function extractEdpRuleFactCandidates(
  pages: readonly string[],
): Promise<EdpRuleFactCandidate[]> {
  const facts: EdpRuleFactCandidate[] = [];
  let section = "";
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    for (const sentence of splitSentences(pages[pageIndex] ?? "")) {
      section = extractSection(sentence, section);
      const classification = classifySentence(sentence);
      if (!classification) continue;
      const normalizedRequirement = normalizeText(sentence).slice(0, 1000);
      const identity = [
        classification.category,
        classification.operator,
        normalizedRequirement,
        classification.condition ?? "",
        pageIndex + 1,
      ].join("|");
      const factId = `fact-${(await sha256Hex(identity)).slice(0, 20)}`;
      facts.push({
        factId,
        category: classification.category,
        section,
        normalizedRequirement,
        operator: classification.operator,
        value: classification.value,
        unit: classification.unit,
        condition: classification.condition,
        page: pageIndex + 1,
        excerpt: normalizedRequirement.slice(0, 240),
        confidence: classification.confidence,
      });
    }
  }
  return facts;
}

export async function parseEdpRuleTextPages(
  input: ParseEdpRuleTextPagesInput,
): Promise<EdpRuleParseResult> {
  if (!Number.isInteger(input.enteredYear) || input.enteredYear < 2000 || input.enteredYear > 2200) {
    throw new EdpRulePdfError("invalid_rule_year", "适用年份必须是 2000 至 2200 之间的四位年份。");
  }
  if (!/^[a-f0-9]{64}$/iu.test(input.sha256)) {
    throw new EdpRulePdfError("invalid_rule_sha256", "竞赛规则文件哈希无效。");
  }
  const usefulCharacters = input.pages.join("").replace(/\s+/gu, "").length;
  if (usefulCharacters === 0) {
    throw new EdpRulePdfError("rule_pdf_has_no_text", "竞赛规则 PDF 没有可提取文字，不能建立可核对的规则版本。");
  }
  const { detectedYear, secondaryYears } = detectRuleYear(input.pages);
  const warnings: string[] = [];
  if (detectedYear === null) warnings.push("正文中没有识别到明确的竞赛年份，请人工确认适用年份。");
  if (secondaryYears.length > 0) {
    warnings.push(`正文还出现年份：${secondaryYears.join("、")}；未替代检测年份 ${detectedYear ?? "未知"}。`);
  }
  const yearConflict = detectedYear !== null && detectedYear !== input.enteredYear;
  if (yearConflict) {
    warnings.push(`填写年份 ${input.enteredYear} 与正文检测年份 ${detectedYear} 不一致，启用前必须明确确认。`);
  }
  const facts = await extractEdpRuleFactCandidates(input.pages);
  if (facts.length === 0) warnings.push("未提取到可结构化的客观规则条目；该版本只能作为人工审核依据。");
  return {
    detectedYear,
    warnings,
    yearConflict,
    version: buildEdpRuleVersion(input.enteredYear, input.sha256, input.builtinRuleVersion),
    facts,
  };
}

function normalizePdfPageItems(items: readonly unknown[]): string {
  return normalizeText(items.map((item) => (
    item && typeof item === "object" && "str" in item && typeof item.str === "string" ? item.str : ""
  )).filter(Boolean).join(" "));
}

export async function extractEdpRulePdfPages(bytes: Uint8Array): Promise<string[]> {
  validateEdpRulePdfEnvelope(bytes);
  try {
    const pdfjs = await loadPdfJs();
    const loadingTask = pdfjs.getDocument({
      data: bytes.slice(),
      useSystemFonts: true,
      verbosity: 0,
    });
    const pdf = await loadingTask.promise;
    const pages: string[] = [];
    try {
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        pages.push(normalizePdfPageItems(content.items));
        page.cleanup();
      }
    } finally {
      try {
        await loadingTask.destroy();
      } catch {
        // PDF.js' bundled fake worker can finish extraction but lack a destroy hook
        // in the Worker runtime. The parsed page data is already detached here.
      }
    }
    return pages;
  } catch (error) {
    if (error instanceof EdpRulePdfError) throw error;
    const code = classifyPdfLoadFailure(error);
    const detail = error instanceof Error ? normalizeText(error.message).slice(0, 160) : "";
    throw new EdpRulePdfError(
      code,
      code === "encrypted_pdf"
        ? "竞赛规则 PDF 已加密或需要密码，无法解析。"
        : `竞赛规则 PDF 已损坏或结构无效，无法解析。${detail ? `（${detail}）` : ""}`,
    );
  }
}

export async function parseEdpRulePdf(input: {
  bytes: Uint8Array;
  enteredYear: number;
  builtinRuleVersion: string;
}): Promise<EdpRuleParseResult & { sha256: string; pages: string[] }> {
  validateEdpRulePdfEnvelope(input.bytes);
  const sha256 = await sha256Hex(input.bytes);
  const pages = await extractEdpRulePdfPages(input.bytes);
  const parsed = await parseEdpRuleTextPages({
    pages,
    enteredYear: input.enteredYear,
    sha256,
    builtinRuleVersion: input.builtinRuleVersion,
  });
  return { ...parsed, sha256, pages };
}
