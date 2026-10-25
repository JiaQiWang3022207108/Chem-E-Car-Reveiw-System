import type {
  EdpDocumentRole,
  EdpReviewDocument,
  EdpReviewEvidence,
  EdpReviewStatus,
} from "./edp-review-rules";

const BUILTIN_RULE_SOURCE = "builtin:v1";

export const EDP_DETAILED_RULE_IDS = Object.freeze([
  "cover_required_fields",
  "cover_bilingual_consistency",
  "cover_registration_consistency",
  "bilingual_objective_consistency",
  "power_equation_logic",
  "control_equation_logic",
  "auxiliary_process",
  "risks_and_mitigations",
  "innovation_statement",
  "outlet_requirement",
  "sop_stages",
  "sop_four_columns",
  "sop_quantification",
  "waste_handling_detail",
  "previous_five_years",
] as const);

export interface RegistrationReference {
  schoolName?: string | null;
  captainName?: string | null;
  teamName?: string | null;
}

export interface DetailedAuditContext {
  registrationReference?: RegistrationReference | null;
  prohibitRecentReactionReuse?: boolean;
  currentPowerEquation?: string | null;
}

export interface DetailedEdpAuditItem {
  ruleId: string;
  row: number;
  status: EdpReviewStatus;
  isBlocking: boolean;
  ruleSource: string;
  worksheetName: "1) EDP Cover Page" | "2) EDP Evaluation";
  suggestedComment: string;
  evidence: EdpReviewEvidence[];
}

export interface EdpCoverFields {
  schoolName: string;
  captainName: string;
  supervisorName: string;
  teamName: string;
  captainEmail: string;
  supervisorEmail: string;
  revision: string;
  revisionDate: string;
}

type CoverField = keyof EdpCoverFields;

const COVER_FIELD_LABELS: Record<CoverField, readonly string[]> = {
  schoolName: ["学校名称", "学校", "School Name", "University Name", "University"],
  captainName: ["队长姓名", "队长", "Captain Name", "Team Captain Name"],
  supervisorName: ["指导教师姓名", "指导老师姓名", "指导教师", "Faculty Advisor Name", "Faculty Supervisor", "Advisor Name", "Supervisor Name"],
  teamName: ["队名", "Team Name", "Vehicle Name", "Work Name", "作品名称"],
  captainEmail: ["队长邮箱", "队长电子邮箱", "Captain Email", "Team Captain Email"],
  supervisorEmail: ["指导教师邮箱", "指导老师邮箱", "Faculty Advisor Email", "Advisor Email", "Supervisor Email"],
  revision: ["Revision #", "Revision No.", "Revision Number", "Revision"],
  revisionDate: ["Revision Date"],
};

const COVER_FIELD_NAMES: Record<CoverField, string> = {
  schoolName: "学校",
  captainName: "队长姓名",
  supervisorName: "指导教师姓名",
  teamName: "队名",
  captainEmail: "队长邮箱",
  supervisorEmail: "指导教师邮箱",
  revision: "Revision",
  revisionDate: "Revision Date",
};

const IGNORED_COVER_LABELS = ["OnsiteSafetyJudge", "OnsiteTrackLength", "OnsiteTrackWidth"] as const;

const ALL_LABELS = [...Object.values(COVER_FIELD_LABELS).flat(), ...IGNORED_COVER_LABELS]
  .sort((left, right) => right.length - left.length);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function comparisonKey(value: string): string {
  return normalizeText(value)
    .toLocaleLowerCase("en-US")
    .replace(/[\s·•._—–-]+/gu, "")
    .replace(/[（）]/gu, (match) => match === "（" ? "(" : ")");
}

function pageText(document: EdpReviewDocument, page = 0): string {
  return document.pages[page] ?? "";
}

function truncate(value: string, limit = 260): string {
  const normalized = normalizeText(value);
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

function locateEvidence(
  documents: readonly EdpReviewDocument[],
  patterns: readonly RegExp[],
  fallbackRole?: EdpDocumentRole,
): EdpReviewEvidence[] {
  for (const document of documents) {
    for (let index = 0; index < document.pages.length; index += 1) {
      const text = document.pages[index] ?? "";
      if (patterns.some((pattern) => {
        pattern.lastIndex = 0;
        return pattern.test(text);
      })) {
        return [{
          documentRole: document.role,
          filename: document.filename,
          page: index + 1,
          excerpt: truncate(text),
        }];
      }
    }
  }
  const fallback = documents.find(({ role }) => role === fallbackRole) ?? documents[0];
  if (!fallback) return [];
  return [{
    documentRole: fallback.role,
    filename: fallback.filename,
    page: 1,
    excerpt: truncate(pageText(fallback)),
  }];
}

function item(
  ruleId: string,
  row: number,
  status: EdpReviewStatus,
  suggestedComment: string,
  evidence: EdpReviewEvidence[],
  worksheetName: DetailedEdpAuditItem["worksheetName"] = "2) EDP Evaluation",
): DetailedEdpAuditItem {
  return {
    ruleId,
    row,
    status,
    isBlocking: true,
    ruleSource: BUILTIN_RULE_SOURCE,
    worksheetName,
    suggestedComment,
    evidence,
  };
}

function readLabeledValue(text: string, labels: readonly string[]): string {
  const labelPattern = labels.map(escapeRegExp).join("|");
  const allLabelsPattern = ALL_LABELS.map(escapeRegExp).join("|");
  const pattern = new RegExp(
    `(?:${labelPattern})\\s*[:：]\\s*([\\s\\S]*?)(?=\\s*(?:\\||\\n|(?:${allLabelsPattern})\\s*[:：]|$))`,
    "iu",
  );
  const value = text.match(pattern)?.[1] ?? "";
  return normalizeText(value);
}

export function extractEdpCoverFields(document: EdpReviewDocument): EdpCoverFields {
  const cover = pageText(document);
  return Object.fromEntries(
    Object.entries(COVER_FIELD_LABELS).map(([field, labels]) => [field, readLabeledValue(cover, labels)]),
  ) as unknown as EdpCoverFields;
}

export interface EdpWorkbookIdentity {
  workName: string;
  instructorName: string;
  instructorEmail: string;
}

export function extractEdpWorkbookIdentity(documents: readonly EdpReviewDocument[]): EdpWorkbookIdentity {
  const preferred = [
    documents.find(({ role }) => role === "chinese_edp"),
    documents.find(({ role }) => role === "english_edp"),
  ].filter((document): document is EdpReviewDocument => Boolean(document));
  const fields = preferred.map(extractEdpCoverFields);
  const firstValue = (key: keyof EdpCoverFields) => fields.find((candidate) => candidate[key])?.[key] ?? "";
  return {
    workName: firstValue("teamName"),
    instructorName: firstValue("supervisorName"),
    instructorEmail: firstValue("supervisorEmail"),
  };
}

function validEmail(value: string): boolean {
  const addresses = value.split(/[\s,，;；]+/u).filter(Boolean);
  return addresses.length > 0 && addresses.every((address) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(address));
}

function validRevision(value: string): boolean {
  return Boolean(value) && !/^(?:待填写|待定|n\/?a|none|-+)$/iu.test(value);
}

function validDate(value: string): boolean {
  const match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function coverEvidence(document: EdpReviewDocument): EdpReviewEvidence[] {
  return [{
    documentRole: document.role,
    filename: document.filename,
    page: 1,
    excerpt: truncate(pageText(document)),
  }];
}

export function auditEdpCover(
  documents: readonly EdpReviewDocument[],
  registration: RegistrationReference | null,
): DetailedEdpAuditItem[] {
  const chinese = documents.find(({ role }) => role === "chinese_edp");
  const english = documents.find(({ role }) => role === "english_edp");
  const missingRoles = [
    !chinese ? "中文版 EDP" : "",
    !english ? "英文版 EDP" : "",
  ].filter(Boolean);
  if (!chinese || !english) {
    const evidence = locateEvidence(documents, [], "chinese_edp");
    return [
      item("cover_required_fields", 13, "no", `缺少${missingRoles.join("和")}，无法检查封面八项必填信息。`, evidence, "1) EDP Cover Page"),
      item("cover_bilingual_consistency", 13, "no", "中英文 EDP 文件不完整，无法核对封面信息一致性。", evidence, "1) EDP Cover Page"),
      item("cover_registration_consistency", 13, "needs_human", "缺少完整中英文封面，报名表一致性需人工确认。", evidence, "1) EDP Cover Page"),
    ];
  }

  const chineseFields = extractEdpCoverFields(chinese);
  const englishFields = extractEdpCoverFields(english);
  const invalid: string[] = [];
  for (const [language, fields] of [["中文版", chineseFields], ["英文版", englishFields]] as const) {
    for (const key of Object.keys(COVER_FIELD_NAMES) as CoverField[]) {
      const value = fields[key];
      const bad = !value
        || ((key === "captainEmail" || key === "supervisorEmail") && !validEmail(value))
        || (key === "revision" && !validRevision(value))
        || (key === "revisionDate" && !validDate(value));
      if (bad) invalid.push(`${language}${COVER_FIELD_NAMES[key]}`);
    }
  }
  const evidence = [...coverEvidence(chinese), ...coverEvidence(english)];
  const required = invalid.length
    ? item("cover_required_fields", 13, "no", `封面必填信息不完整或格式无效：${invalid.join("、")}。`, evidence, "1) EDP Cover Page")
    : item("cover_required_fields", 13, "yes", "中英文封面的学校、队长、指导教师、队名、两项邮箱、Revision 和 Revision Date 均已填写。", evidence, "1) EDP Cover Page");

  const objectiveFields: CoverField[] = ["captainEmail", "supervisorEmail", "revision", "revisionDate"];
  const objectiveMismatches = objectiveFields.filter((key) => comparisonKey(chineseFields[key]) !== comparisonKey(englishFields[key]));
  const identityFields: CoverField[] = ["schoolName", "captainName", "supervisorName", "teamName"];
  const identityDifferences = identityFields.filter((key) => comparisonKey(chineseFields[key]) !== comparisonKey(englishFields[key]));
  let bilingual: DetailedEdpAuditItem;
  if (objectiveMismatches.length) {
    bilingual = item(
      "cover_bilingual_consistency",
      13,
      "no",
      `中英文封面的客观字段不一致：${objectiveMismatches.map((key) => COVER_FIELD_NAMES[key]).join("、")}。`,
      evidence,
      "1) EDP Cover Page",
    );
  } else if (identityDifferences.length) {
    bilingual = item(
      "cover_bilingual_consistency",
      13,
      "needs_human",
      `中英文姓名或名称可能为翻译写法，请人工确认：${identityDifferences.map((key) => COVER_FIELD_NAMES[key]).join("、")}。`,
      evidence,
      "1) EDP Cover Page",
    );
  } else {
    bilingual = item("cover_bilingual_consistency", 13, "yes", "中英文封面八项信息一致。", evidence, "1) EDP Cover Page");
  }

  const referenceChecks: Array<[CoverField, string | null | undefined]> = [
    ["schoolName", registration?.schoolName],
    ["captainName", registration?.captainName],
    ["teamName", registration?.teamName],
  ];
  const availableReferenceChecks = referenceChecks.filter(([, value]) => Boolean(value));
  const registrationMismatches = availableReferenceChecks.filter(([key, value]) => comparisonKey(chineseFields[key]) !== comparisonKey(value ?? ""));
  let registrationItem: DetailedEdpAuditItem;
  if (!registration || !availableReferenceChecks.length) {
    registrationItem = item("cover_registration_consistency", 13, "needs_human", "未取得对应报名表的学校、队长或队名信息，需人工核对。", coverEvidence(chinese), "1) EDP Cover Page");
  } else if (registrationMismatches.length) {
    registrationItem = item(
      "cover_registration_consistency",
      13,
      "no",
      `中文版 EDP 封面与报名表不一致：${registrationMismatches.map(([key]) => COVER_FIELD_NAMES[key]).join("、")}。`,
      coverEvidence(chinese),
      "1) EDP Cover Page",
    );
  } else {
    registrationItem = item("cover_registration_consistency", 13, "yes", "中文版 EDP 封面的学校、队长和队名与报名表一致。", coverEvidence(chinese), "1) EDP Cover Page");
  }

  return [required, bilingual, registrationItem];
}

function normalizeEquation(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/−/gu, "-")
    .replace(/(?:→|⇒|⟶|->|=)/gu, "->")
    .replace(/⇌/gu, "<=>")
    .replace(/\((?:aq|s|l|g)\)/giu, "")
    .replace(/\s+/gu, "")
    .replace(/[。；;,，]/gu, "")
    .toLocaleLowerCase("en-US");
}

function extractEquations(text: string): string[] {
  text = text.normalize("NFKC").replace(/−/gu, "-");
  // PDF text items often separate a subscript/charge from its element. Join
  // only formula-shaped fragments, without altering prose or numeric facts.
  text = text.replace(/([A-Za-z)])\s+(\d+)(?=\s*[A-Z() +\-→=]|$)/gu, "$1$2")
    .replace(/([A-Z][a-z]?\d*)\s+(?=[A-Z][a-z]?(?:\d|\s*[+\-→=]))/gu, "$1")
    .replace(/([A-Za-z0-9)])\s+([+-])(?=\s*(?:→|⇒|⟶|->|=|\+|[.;；。]|$))/gu, "$1$2");
  const component = String.raw`(?:\d*[A-Za-z][A-Za-z0-9()\[\]+\-]*|\d+[A-Za-z][A-Za-z0-9()\[\]+\-]*)`;
  const expression = String.raw`${component}(?:\s*\+\s*${component})*`;
  const pattern = new RegExp(`${expression}\\s*(?:→|⇒|⟶|->|⇌|=)\\s*${expression}`, "gu");
  return [...text.matchAll(pattern)].map((match) => normalizeEquation(match[0] ?? ""));
}

function extractNumericFacts(text: string): string[] {
  return objectiveQuantities(text).map(({ dimension, value }) => `${dimension}:${value}`);
}

interface ObjectiveQuantity {
  dimension: string;
  value: number;
  rawValue: number;
  factor: number;
  offset: number;
  precision: number;
  unit: string;
  display: string;
  field?: string;
  label?: string;
  index: number;
}

const OBJECTIVE_UNITS: Readonly<Record<string, readonly [string, number, number?]>> = {
  "mol/l": ["concentration", 1], "mmol/l": ["concentration", 0.001],
  ml: ["volume", 1], l: ["volume", 1000], ul: ["volume", 0.001], "µl": ["volume", 0.001],
  g: ["mass", 1], mg: ["mass", 0.001], kg: ["mass", 1000],
  pa: ["pressure", 1], kpa: ["pressure", 1000], mpa: ["pressure", 1_000_000], bar: ["pressure", 100_000],
  psig: ["gauge-pressure", 6894.757293168], barg: ["gauge-pressure", 100_000],
  psia: ["absolute-pressure", 6894.757293168], bara: ["absolute-pressure", 100_000], atm: ["absolute-pressure", 101_325],
  psi: ["pressure", 6894.757293168],
  s: ["time", 1], ms: ["time", 0.001], min: ["time", 60],
  "°c": ["temperature", 1], k: ["temperature", 1, -273.15],
  v: ["voltage", 1], a: ["current", 1], hz: ["frequency", 1], rpm: ["rotation-rate", 1],
};

const OBJECTIVE_CHEMICAL_NAMES = [
  ["KOH", "氢氧化钾（KOH）", /氢氧化钾|potassium\s+hydroxide|\bKOH\b/giu],
  ["NaOH", "氢氧化钠（NaOH）", /氢氧化钠|sodium\s+hydroxide|\bNaOH\b/giu],
  ["HCl", "盐酸（HCl）", /盐酸|hydrochloric\s+acid|\bHCl\b/giu],
  ["H2SO4", "硫酸（H2SO4）", /硫酸(?![钾钠镍铜锌铝])|sulfuric\s+acid|\bH2SO4\b/giu],
  ["H2O2", "过氧化氢（H2O2）", /过氧化氢|hydrogen\s+peroxide|\bH2O2\b/giu],
  ["NaHSO3", "亚硫酸氢钠（NaHSO3）", /亚硫酸氢钠|sodium\s+bisulfite|\bNaHSO3\b/giu],
  ["Na2SO3", "亚硫酸钠（Na2SO3）", /亚硫酸钠|sodium\s+sulfite|\bNa2SO3\b/giu],
  ["Na2S2O3", "硫代硫酸钠（Na2S2O3）", /硫代硫酸钠|sodium\s+thiosulfate|\bNa2S2O3\b/giu],
  ["KIO3", "碘酸钾（KIO3）", /碘酸钾|potassium\s+iodate|\bKIO3\b/giu],
  ["KI", "碘化钾（KI）", /碘化钾|potassium\s+iodide|\bKI\b/giu],
] as const;

function objectiveQuantities(source: string): ObjectiveQuantity[] {
  const text = source.normalize("NFKC");
  const pattern = /(?<![A-Za-z0-9])([-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?)\s*(mmol\s*\/\s*L|mol\s*\/\s*L|MPa|kPa|Pa|psig|psia|psi|barg|bara|bar|atm|mL|µL|uL|L|kg|mg|g|min|ms|s|°C|K|V|A|Hz|rpm)(?![A-Za-z])/giu;
  const quantities: ObjectiveQuantity[] = [];
  for (const match of text.matchAll(pattern)) {
    const unit = match[2].replace(/\s+/gu, "").toLocaleLowerCase("en-US");
    const definition = OBJECTIVE_UNITS[unit];
    if (!definition) continue;
    const [dimension, factor, offset = 0] = definition;
    const index = match.index ?? 0;
    const rawValue = Number(match[1]);
    const value = Number((rawValue * factor + offset).toPrecision(12));
    if (!Number.isFinite(value)) continue;
    const local = text.slice(Math.max(0, index - 64), index + match[0].length + 48);
    const lastSection = [...text.slice(0, index).matchAll(/动力来源|推进系统|power\s+(?:source|mechanism)|控制机制|制动机制|control\s+mechanism|stopping\s+mechanism/giu)].at(-1)?.[0] ?? "";
    const scope = /动力|推进|power/iu.test(lastSection) ? "power" : /控制|制动|control|stopping/iu.test(lastSection) ? "control" : "unspecified";
    let field: string | undefined;
    let label: string | undefined;
    if (dimension === "concentration") {
      const candidates = OBJECTIVE_CHEMICAL_NAMES.flatMap(([key, name, expression]) => {
        expression.lastIndex = 0;
        return [...local.matchAll(expression)].map(hit => ({ key, name,
          distance: Math.min(Math.abs((hit.index ?? 0) - Math.min(index, 64)),
            Math.abs((hit.index ?? 0) + hit[0].length - Math.min(index, 64))) }));
      }).sort((left, right) => left.distance - right.distance);
      const chemical = candidates[0];
      if (chemical && (!candidates[1] || chemical.distance < candidates[1].distance)) {
        field = `${dimension}:${chemical.key}:${scope}`;
        label = `${chemical.name}浓度`;
      }
    } else if (dimension.includes("pressure") && /压力|pressure/iu.test(local)) {
      const before = text.slice(Math.max(0, index - 32), index);
      const condition = /最大|max(?:imum)?|MOP|MAWP/iu.test(before) ? "maximum"
        : /最小|min(?:imum)?/iu.test(before) ? "minimum" : "operating";
      field = `${dimension}:${condition}:${scope}`;
      label = condition === "maximum" ? "最大压力" : condition === "minimum" ? "最小压力" : "操作压力";
    }
    quantities.push({ dimension, value, rawValue, factor, offset, unit, index, field, label,
      display: match[0], precision: (match[1].split(".")[1]?.split(/e/iu)[0] ?? "").length });
  }
  return quantities;
}

function equivalentQuantity(left: ObjectiveQuantity, right: ObjectiveQuantity): boolean {
  if (left.dimension !== right.dimension) return false;
  if (Math.abs(left.value - right.value) <= Math.max(1, Math.abs(left.value), Math.abs(right.value)) * 1e-11) return true;
  if (left.unit === right.unit) return false;
  // Different display units may round the same measurement. No blanket
  // percentage tolerance: both conversions must round to the supplied values.
  const toRight = (left.value - right.offset) / right.factor;
  const toLeft = (right.value - left.offset) / left.factor;
  return Number(toRight.toFixed(Math.min(12, right.precision))) === right.rawValue
    && Number(toLeft.toFixed(Math.min(12, left.precision))) === left.rawValue;
}

function setDifference(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  return [...left].filter((value) => !right.has(value));
}

export const EDP_ENGLISH_ONLY_SECTION_PATTERNS = Object.freeze([
  /\bHazards?\s+Analysis\b/iu,
  /\bLaboratory\s+(?:Floor\s+Plan|Layout)\b/iu,
  /\bVehicle\s+Primary\s+Hazards?\s+Checklist\b/iu,
  /\bChemical\s+Information\s+Page\b/iu,
] as const);

function bilingualComparablePages(document: EdpReviewDocument): Array<{ text: string; page: number }> {
  const pages: Array<{ text: string; page: number }> = [];
  let history = false;
  for (let index = 1; index < document.pages.length; index += 1) {
    const text = document.pages[index].normalize("NFKC");
    if (/历届比赛作品|近五年(?:方案|作品)|(?:Previous|Past)\s+(?:Five|5)\s+Years/iu.test(text)) {
      history = true;
      continue;
    }
    if (history && /安全培训|规则认证|Safety\s+(?:Training|Certification)|标准\s*\/\s*安全操作|Standard\s*\/\s*Safe\s+Operating|\bEquipment\s*List\b|Chemical\s+Information\s+Page/iu.test(text)) history = false;
    if (history) continue;
    if (document.role === "english_edp" && EDP_ENGLISH_ONLY_SECTION_PATTERNS.some(pattern => {
      pattern.lastIndex = 0;
      return pattern.test(text);
    })) continue;
    pages.push({ text, page: index + 1 });
  }
  return pages;
}

export function auditBilingualObjectiveConsistency(
  documents: readonly EdpReviewDocument[],
): DetailedEdpAuditItem {
  const chinese = documents.find(({ role }) => role === "chinese_edp");
  const english = documents.find(({ role }) => role === "english_edp");
  const core = documents.filter(({ role }) => role === "chinese_edp" || role === "english_edp");
  const evidence = core.flatMap(document => locateEvidence([document], [/动力|控制|power|control/iu], document.role));
  if (!chinese || !english) {
    return item("bilingual_objective_consistency", 8, "no", "缺少中文版或英文版 EDP，无法核对中英文客观信息。", evidence);
  }
  if (chinese.textQuality !== "usable" || english.textQuality !== "usable") {
    return item("bilingual_objective_consistency", 8, "needs_human", "中英文 PDF 存在文字读取不可靠的情况，不能把提取遗漏当作内容矛盾。请核对所列原 PDF 页。", evidence);
  }
  const mocTitle = /MANAGEMENT\s+OF\s+CHANGE\s+REQUEST\s+FORM|PROCESS\s+CHANGE\s+REQUEST\s+APPROVAL\s+FORM/iu;
  const wrongRole = core.find(document => mocTitle.test((document.pages[0] ?? "").slice(0, 600))
    && !/工程文件包|Engineering\s+Documentation\s+Package/iu.test((document.pages[0] ?? "").slice(0, 250)));
  if (wrongRole) {
    return item("bilingual_objective_consistency", 8, "no", `${wrongRole.filename} 的正文为 MOC 变更管理表，不能代替${wrongRole.role === "english_edp" ? "英文" : "中文"}版 EDP。`,
      [{ documentRole: wrongRole.role, filename: wrongRole.filename, page: 1, excerpt: truncate(wrongRole.pages[0] ?? "") }]);
  }
  const chinesePages = bilingualComparablePages(chinese);
  const englishPages = bilingualComparablePages(english);
  const chineseBody = chinesePages.map(({ text }) => text).join("\n");
  const englishBody = englishPages.map(({ text }) => text).join("\n");
  const chineseEquations = new Set(extractEquations(chineseBody));
  const englishEquations = new Set(extractEquations(englishBody));
  const facts = (document: EdpReviewDocument, pages: typeof chinesePages) => pages.flatMap(({ text, page }) =>
    objectiveQuantities(text).map(quantity => ({ ...quantity, document, page, text })));
  const chineseFacts = facts(chinese, chinesePages);
  const englishFacts = facts(english, englishPages);
  const hasObjectiveEvidence = chineseEquations.size + englishEquations.size + chineseFacts.length + englishFacts.length > 0;
  if (!hasObjectiveEvidence) {
    return item("bilingual_objective_consistency", 8, "needs_human", "未提取到足够的方程式或带单位数值，中英文叙述一致性需人工确认。", evidence);
  }
  // Only an identified common field can establish a numeric contradiction.
  // Unmatched numbers from different sections are not proof of disagreement.
  for (const field of new Set(chineseFacts.flatMap(fact => fact.field ? [fact.field] : []))) {
    const unique = (values: typeof chineseFacts) => values.filter((value, index) =>
      !values.slice(0, index).some(previous => equivalentQuantity(previous, value)));
    const left = unique(chineseFacts.filter(fact => fact.field === field));
    const right = unique(englishFacts.filter(fact => fact.field === field));
    if (left.length !== 1 || right.length !== 1 || equivalentQuantity(left[0], right[0])) continue;
    const conflict = [left[0], right[0]];
    return item("bilingual_objective_consistency", 8, "no",
      `中英文同一${left[0].label}的数值不一致：中文版 ${left[0].display}，英文版 ${right[0].display}（已核对单位）。`,
      conflict.map(fact => ({ documentRole: fact.document.role, filename: fact.document.filename, page: fact.page,
        excerpt: truncate(fact.text.slice(Math.max(0, fact.index - 90), fact.index + fact.display.length + 130)) })));
  }
  const equationDifference = [
    ...setDifference(chineseEquations, englishEquations),
    ...setDifference(englishEquations, chineseEquations),
  ];
  const numericMatch = chineseFacts.every(left => englishFacts.some(right => equivalentQuantity(left, right)))
    && englishFacts.every(right => chineseFacts.some(left => equivalentQuantity(left, right)));
  if (equationDifference.length || !numericMatch) {
    return item("bilingual_objective_consistency", 8, "needs_human", "中英文提取到的内容不能全部逐项对应；可能涉及离子/分子方程式、章节范围或数值用途差异。尚未证实同一参数矛盾，不直接判不合格。", evidence);
  }
  return item("bilingual_objective_consistency", 8, "yes", "中英文可比章节中提取到的化学方程式和数值一致；已规范化上下标、空格及等效单位，不比较往年方案和英文专属章节。", evidence);
}

function primaryDocument(documents: readonly EdpReviewDocument[]): EdpReviewDocument | undefined {
  return documents.find(({ role, textQuality }) => role === "chinese_edp" && textQuality === "usable")
    ?? documents.find(({ role, textQuality }) => role === "english_edp" && textQuality === "usable")
    ?? documents.find(({ role }) => role === "chinese_edp")
    ?? documents.find(({ role }) => role === "english_edp");
}

function sourceText(documents: readonly EdpReviewDocument[]): string {
  const preferred = primaryDocument(documents);
  return (preferred?.pages.join("\n") ?? "")
    .replace(/更新于\s*20\d{2}\s*年\s*\d{1,2}\s*月\s*\d{1,3}/gu, "");
}

function sectionBetween(text: string, starts: readonly RegExp[], stops: readonly RegExp[]): string {
  let start = -1;
  let startLength = 0;
  for (const pattern of starts) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match && (start === -1 || match.index < start)) {
      start = match.index;
      startLength = match[0].length;
    }
  }
  if (start < 0) return "";
  const rest = text.slice(start + startLength);
  let end = rest.length;
  for (const pattern of stops) {
    pattern.lastIndex = 0;
    const match = pattern.exec(rest);
    if (match && match.index < end) end = match.index;
  }
  return rest.slice(0, end).trim();
}

function hasAll(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.every((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

function isExplicitNotApplicable(text: string): boolean {
  return /(?:不适用|无需|无此过程|N\/?A|not\s+applicable)/iu.test(text);
}

function yesNoItem(
  ruleId: string,
  row: number,
  passed: boolean,
  success: string,
  failure: string,
  evidence: EdpReviewEvidence[],
): DetailedEdpAuditItem {
  return item(ruleId, row, passed ? "yes" : "no", passed ? success : failure, evidence);
}

function authoredSopBody(text: string): string {
  const columns = /步骤顺序|Step\s+Sequence/iu.exec(text);
  // Instructions repeat the names of all stages, but are not the team's steps.
  return (columns ? text.slice(columns.index) : text)
    .replace(/更新于\s*20\d{2}\s*年\s*\d{1,2}\s*月\s*\d{1,3}/gu, "");
}

function sopStageCount(text: string): number {
  const stages = [
    /紧急(?:停止|情况)|emergency/iu,
    /开始过程|准备过程|开始\s*\/\s*准备|run\s+prep|prepar/iu,
    /行驶过程|运行过程|起点过程|起步过程|起跑线|starting\s+line|start(?:up)?\s+procedure|during\s+(?:the\s+)?run/iu,
    /停止过程|停车过程|stopping/iu,
    /(?:行驶距离|距离).{0,12}(?:调整|调节)|distance.{0,12}adjust/iu,
    /清洁|赛后处置|清理|cleanup|post[- ]competition/iu,
  ];
  const matches = stages.flatMap((pattern, stage) => {
    const match = pattern.exec(text);
    return match ? [{ stage, index: match.index, end: match.index + match[0].length }] : [];
  }).sort((left, right) => left.index - right.index);
  return matches.filter((match, index) => {
    const content = text.slice(match.end, matches[index + 1]?.index ?? text.length)
      .replace(/部分应(?:描述|列出)[^。]*。/gu, "")
      .replace(/步骤顺序|潜在危险|控制\s*风险的\s*步骤|所需个人防护\s*用品或设备/gu, "")
      .replace(/[\s:：|.。]/gu, "");
    return content.length >= 4;
  }).length;
}

function splitHistoryEntries(text: string): Array<{ year: string; content: string }> {
  const entries: Array<{ year: string; content: string }> = [];
  const pattern = /((?:20)?\d{2})\s*[：:]/gu;
  const matches = [...text.matchAll(pattern)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? text.length;
    entries.push({ year: match[1], content: text.slice(start, end).trim() });
  }
  return entries;
}

export function auditDetailedEdpDocuments(
  documents: readonly EdpReviewDocument[],
  context: DetailedAuditContext = {},
): DetailedEdpAuditItem[] {
  const text = sourceText(documents);
  const fallbackRole = primaryDocument(documents)?.role;
  const core = documents.filter(({ role }) => role === "chinese_edp" || role === "english_edp");
  const evidenceFor = (...patterns: RegExp[]) => locateEvidence(core, patterns, fallbackRole);
  const unreadableCore = core.length > 0 && !core.some(document => document.textQuality === "usable");

  const powerSection = sectionBetween(
    text,
    [/动力来源\s*[:：]?/iu, /power\s+(?:source|mechanism)\s*[:：]?/iu],
    [/控制机制|制动机制|停止机制|(?:control|stopping|braking)\s+mechanism/iu, /辅助过程|auxiliary\s+process/iu],
  );
  const powerEquations = extractEquations(powerSection);
  const powerPassed = powerEquations.length > 0
    && /推进|推动|驱动|产气|压力|活塞|电机|马达|电能|外电路|propel|drive|gas|pressure|motor|electri|external\s+circuit/iu.test(powerSection);

  const controlSection = sectionBetween(
    text,
    [/(?:控制机制|制动机制|停止机制)(?:[（(][^）)]{0,30}[）)])?\s*[:：]/iu,
      /(?:control|stopping|braking)\s+mechanism(?:\([^)]{0,30}\))?\s*[:：]/iu,
      /(?:^|\n)(?:控制机制|制动机制|停止机制|(?:control|stopping|braking)\s+mechanism)\s*(?:\n|$)/iu],
    [/辅助过程|auxiliary\s+process/iu, /(?:设计过程中隐含的)?潜在风险/iu, /创新点/iu],
  );
  const controlPassed = extractEquations(controlSection).length > 0
    && /停止|制动|触发|终止|颜色|计时|stop|brak|trigger|color|colour|tim/iu.test(controlSection);

  const auxiliarySection = sectionBetween(
    text,
    [/辅助过程[^:：\n]{0,120}[:：]/iu, /auxiliary\s+process(?:es)?[^:：\n]{0,120}[:：]/iu, /辅助过程/iu],
    [/控制机制|制动机制|停止机制|(?:control|stopping|braking)\s+mechanism/iu, /(?:设计过程中隐含的)?潜在风险/iu, /创新点/iu, /比赛现场电源插座/iu],
  );
  let auxiliaryItem: DetailedEdpAuditItem;
  if (!normalizeText(auxiliarySection)) {
    const requiresAuxiliary = /(?:需要|须|需|requires?).{0,30}(?:外部充电|辅助加热|辅助冷却|external\s+charg|auxiliary\s+heat|auxiliary\s+cool)/iu.test(text);
    auxiliaryItem = item("auxiliary_process", 29, requiresAuxiliary ? "needs_human" : "not_applicable",
      requiresAuxiliary ? "设计提到需要额外辅助工序，但辅助过程栏目为空；请核对其他章节是否已说明条件和风险控制。"
        : "辅助过程是按方案适用的可选栏目；未描述额外辅助工序时允许留空，不因空白直接判不合格。", evidenceFor(/辅助过程|auxiliary/iu));
  } else if (isExplicitNotApplicable(auxiliarySection) || /^(?:无|none|no)[。.\s]*$/iu.test(normalizeText(auxiliarySection))) {
    auxiliaryItem = item("auxiliary_process", 29, "not_applicable", "参赛队明确说明辅助过程不适用。", evidenceFor(/辅助过程|auxiliary/iu));
  } else {
    const auxiliaryConditions = sectionBetween(text,
      [/对于辅助过程[^:：\n]{0,80}预期操作条件\s*[:：]?/iu,
        /For\s+the\s+auxiliary\s+process(?:es)?[^:：\n]{0,100}Expected\s+Operating\s+Conditions\s*[:：]?/iu],
      [/小车完整照片|小车完整图片|Complete\s+(?:Picture|Photo)|标准\s*\/?\s*安全操作/iu]);
    const auxiliaryPassed = Boolean(auxiliarySection)
      && /过程|充电|加热|冷却|混合|制备|配制|预制|浸润|检查|组装|process|charg|heat|cool|mix|prepar/iu.test(auxiliarySection)
      && (/条件|温度|时间|电压|风险|危险|防护|condition|temperature|time|voltage|risk|hazard|protect/iu.test(auxiliarySection)
        || extractNumericFacts(auxiliarySection).length > 0
        || extractNumericFacts(auxiliaryConditions).length > 0);
    auxiliaryItem = yesNoItem("auxiliary_process", 29, auxiliaryPassed, "辅助过程及其条件或安全措施已说明。", "辅助过程未说明具体操作条件及相应风险控制；若确实不适用，请明确填写“不适用”。", evidenceFor(/辅助过程|auxiliary/iu));
  }

  const riskSection = sectionBetween(
    text,
    [/潜在风险\s*[:：]?/iu, /potential\s+(?:risk|hazard)s?\s*[:：]?/iu],
    [/创新点\s*[:：]?/iu, /比赛现场电源插座\s*[:：]?/iu, /标准\s*\/?\s*安全操作/iu],
  );
  const riskPassed = Boolean(riskSection)
    && !/^(?:无风险|无|none|no\s+risk)/iu.test(normalizeText(riskSection))
    && /腐蚀|泄漏|压力|火灾|爆炸|灼伤|中毒|电击|危险|risk|hazard|corrosi|leak|pressure|fire|explosion|burn|toxic|shock/iu.test(riskSection)
    && /预防|减轻|措施|护目镜|手套|密闭|泄压|通风|隔离|prevent|mitigat|goggle|glove|contain|relief|ventilat/iu.test(riskSection);

  const innovationSection = sectionBetween(
    text,
    [/创新点\s*[:：]?/iu, /innovation\s*[:：]?/iu],
    [/比赛现场电源插座\s*[:：]?/iu, /标准\s*\/?\s*安全操作/iu, /近五年方案\s*[:：]?/iu],
  );
  const innovationPassed = normalizeText(innovationSection).length >= 12
    && !/(?:待填写|暂无|无创新|同往年|to\s+be\s+filled|none)/iu.test(innovationSection)
    && /动力|控制|反应|电极|催化|复合|结构|材料|传感|创新|改进|优化|新型|闭环|降低|提高|power|control|react|electrode|catalys|composite|structure|material|sensor|novel|improv|optimiz|closed[- ]loop|reduce|increase/iu.test(innovationSection);

  const outletSection = sectionBetween(
    text,
    [/比赛现场电源插座\s*[:：]?/iu, /onsite\s+(?:power\s+)?outlet\s*[:：]?/iu],
    [/标准\s*\/?\s*安全操作/iu, /近五年方案\s*[:：]?/iu, /standard\s+operating/iu],
  );
  let outletItem: DetailedEdpAuditItem;
  if (outletSection && isExplicitNotApplicable(outletSection)) {
    outletItem = item("outlet_requirement", 37, "not_applicable", "参赛队明确说明比赛现场电源插座不适用。", evidenceFor(/电源插座|outlet/iu));
  } else {
    const outletPassed = Boolean(outletSection)
      && /(?:\d+(?:\.\d+)?\s*(?:V|A|W|Hz))|(?:电压|功率|频率|交流|直流|voltage|power|frequency|AC|DC)/iu.test(outletSection)
      && /用途|设备|供电|充电|加热|purpose|equipment|supply|charg|heat/iu.test(outletSection);
    outletItem = yesNoItem("outlet_requirement", 37, outletPassed, "现场电源插座需求、参数和用途已说明。", "仅说明需要电源不足以审核，请填写插座用途及电压、功率或频率等供电参数；若不需要，请明确填写“不适用”。", evidenceFor(/电源插座|outlet/iu));
  }

  const sopText = authoredSopBody(sectionBetween(
    text,
    [/标准\s*\/?\s*安全操作(?:程序|页)?\s*[:：]?/iu, /standard\s*(?:\/\s*)?(?:safe\s+)?operating\s+procedures?(?:\s+page)?\s*[:：]?/iu],
    [/历届比赛作品\s*[:：]?/iu, /近五年方案\s*[:：]?/iu, /previous\s+(?:five|5)\s+years/iu],
  ));
  const emergencySection = sectionBetween(sopText, [/紧急(?:停止|情况)\s*[:：]?/iu, /emergency\s*[:：]?/iu], [/开始|启动|准备|start|prepar/iu]);
  const emergencySteps = [...emergencySection.matchAll(/(?:^|[；;。]|\s)(\d+)[.、]/gu)].length;
  const stagesPassed = sopStageCount(sopText) === 6 && (emergencySteps === 0 || emergencySteps <= 2);
  const fourColumnsPassed = hasAll(sopText, [
    /步骤顺序|step\s+sequence/iu,
    /潜在危险|potential\s+hazard/iu,
    /控制\s*风险的\s*步骤|risk\s+control|control\s+method/iu,
    /个人防护\s*用品|防护设备|personal\s+protective|PPE/iu,
  ]);
  // Describing a small residue or a hypothetical spill is not an unquantified
  // reactant dose. Evaluate amount words together with dosing verbs/objects.
  const containsVagueQuantity = sopText.split(/[。；;\n]/u).some(clause =>
    /适量|少量|若干|按需|酌量|一定量|一定配比|一定比例|特定配方|按比例|as\s+needed|appropriate\s+amount|specific\s+formula|certain\s+proportion/iu.test(clause)
    && /量取|称取|称量|取用|加入|添加|滴加|注入|配制|混合|移取|\badd|\bweigh|\bmeasure|pipett|dispens|inject|prepar|\bmix/iu.test(clause)
    && /盐酸|硫酸|过氧化氢|碘|硫代硫酸|氢氧化|锌|酸|碱|试剂|药品|反应物|电解液|溶液|HCl|H2O2|NaOH|Zn|chemical|reagent|reactant|solution/iu.test(clause)
    && !/若.{0,20}(?:洒出|溢出|泄漏)|(?:in\s+case|if).{0,25}(?:spill|leak)/iu.test(clause));
  const chemicalNamed = /盐酸|硫酸|过氧化氢|碘|硫代硫酸|氢氧化|锌|酸|碱|HCl|H2O2|NaOH|Zn|chemical|reagent/iu.test(sopText);
  // Concentration, ambient temperature and an equipment rating are not doses.
  // Do not mistake the g in g/L for a mass added to the reaction.
  const doseBody = sopText.normalize("NFKC")
    .replace(/\d+(?:\.\d+)?\s*(?:kg|mg|g|mL|L|cm3|毫升|升|克)\s*(?:的)?(?:烧杯|容量瓶|反应器|反应瓶|比色皿|烧瓶|量筒|注射器|移液枪|beaker|flask|reactor|vessel|syringe|pipette)/giu,"");
  const actualDose = doseBody.split(/[。；;，,\n]/u).some(clause =>
    /盐酸|硫酸|过氧化氢|碘|硫代硫酸|氢氧化|锌|酸|碱|试剂|药品|反应物|电解液|溶液|HCl|H2O2|NaOH|KOH|Zn|chemical|reagent|reactant|solution|electrolyte|acid|peroxide|chloride|sulfate/iu.test(clause)
    && /(?<![\d./])\d+(?:\.\d+)?\s*(?:kg|mg|[µμu]g|g|mL|[µμu]L|L|cm3|毫升|微升|升|千克|毫克|克)(?![A-Za-z]|\s*[/／]|\s*(?:m?L|升)\s*(?:\^?\s*[-−]\s*1))/u.test(clause));
  const quantified = chemicalNamed && actualDose && !containsVagueQuantity;
  const wasteSection = sectionBetween(
    sopText,
    [/废物处理\s*[:：]?/iu, /waste\s+(?:handling|disposal)\s*[:：]?/iu],
    [/近五年方案\s*[:：]?/iu, /previous\s+(?:five|5)\s+years/iu],
  );
  const unsafeDischarge = wasteSection.split(/[。；;，,\n]/u).some(clause =>
    !/(?:禁止|不得|不允许|不可|不)(?:直接|随意)?(?:排入|倒入|排放)|(?:do\s+not|must\s+not|never)\s+(?:discharge|pour|drain)|no\s+discharge/iu.test(clause)
    && /排入|倒入|排放到|discharg|pour|drain/iu.test(clause)
    && /下水道|水槽|水沟|sewer|sink|\bdrain\b/iu.test(clause));
  const wastePassed = !unsafeDischarge && hasAll(wasteSection, [
    /酸|碱|金属|溶液|废液|固体|成分|腐蚀|有毒|acid|base|metal|solution|composition|corrosi|toxic/iu,
    /容器|桶|瓶|密闭|带盖|container|bottle|sealed|lid/iu,
    /标签|标注|label/iu,
    /不得.{0,16}混合|不可.{0,16}混合|分开|相容|incompat|do\s+not\s+mix|separate/iu,
    /危废|回收|处理中心|交由|处置|hazardous\s+waste|recycl|disposal\s+(?:center|facility)|hand\s+over/iu,
  ]);

  const historySection = sectionBetween(
    text,
    [/近五年方案\s*[:：]?/iu, /(?:previous|past)\s+(?:five|5)\s+years\s*[:：]?/iu],
    [],
  );
  let historyItem: DetailedEdpAuditItem;
  if (!normalizeText(historySection) || /^(?:无|首次参赛|不适用|none|first\s+participation)[。.]?$/iu.test(normalizeText(historySection))) {
    historyItem = item("previous_five_years", 32, "not_applicable", "近五年方案为空或已说明首次参赛/无历史方案，允许不填满五年。", evidenceFor(/近五年|previous\s+(?:five|5)/iu));
  } else {
    const entries = splitHistoryEntries(historySection);
    const substantive = entries.filter(({ content }) => !/^(?:无|未参赛|不适用|none|n\/?a)[。.;；]?$/iu.test(normalizeText(content)));
    const incomplete = substantive.filter(({ content }) => {
      const equations = extractEquations(content);
      return !/动力|power/iu.test(content) || !/控制|control/iu.test(content) || equations.length === 0;
    });
    const currentEquation = context.currentPowerEquation
      ? normalizeEquation(context.currentPowerEquation)
      : (powerEquations[0] ?? "");
    const repeated = currentEquation
      ? substantive.find(({ content }) => extractEquations(content).includes(currentEquation))
      : undefined;
    if (context.prohibitRecentReactionReuse && repeated) {
      historyItem = item("previous_five_years", 32, "no", `${repeated.year} 年历史方案与当年动力反应方程式相同，请核对是否违反近五年不得重复的要求。`, evidenceFor(/近五年|previous\s+(?:five|5)/iu));
    } else if (incomplete.length) {
      historyItem = item("previous_five_years", 32, "no", `近五年历史方案信息不完整：${incomplete.map(({ year }) => year).join("、")} 年缺少动力、控制或反应方程式。`, evidenceFor(/近五年|previous\s+(?:five|5)/iu));
    } else if (substantive.length) {
      historyItem = item("previous_five_years", 32, "yes", "已填写的近五年历史方案包含动力、控制和反应方程式；未参赛年份允许为空。", evidenceFor(/近五年|previous\s+(?:five|5)/iu));
    } else {
      historyItem = item("previous_five_years", 32, "not_applicable", "近五年各年份均注明未参赛或无历史方案。", evidenceFor(/近五年|previous\s+(?:five|5)/iu));
    }
  }

  const results = [
    yesNoItem("power_equation_logic", 10, powerPassed, "动力来源已检出反应表达式和推进逻辑；具体剂量在 SOP 中另行检查。", "动力来源未检出反应表达式或推进逻辑。", evidenceFor(/动力来源|power\s+(?:source|mechanism)/iu)),
    yesNoItem("control_equation_logic", 10, controlPassed, "控制/制动机制已检出反应表达式及触发停止逻辑。", "控制/制动机制未检出反应表达式或触发停止逻辑。", evidenceFor(/控制机制|制动机制|停止机制|(?:control|stopping|braking)\s+mechanism/iu)),
    auxiliaryItem,
    yesNoItem("risks_and_mitigations", 31, riskPassed, "潜在风险与具体预防、减轻措施已对应说明。", "潜在风险或相应的预防、减轻措施不具体；涉及化学反应时不能仅填写“无风险”或“注意安全”。", evidenceFor(/潜在风险|potential\s+(?:risk|hazard)/iu)),
    yesNoItem("innovation_statement", 32, innovationPassed, "动力或控制系统的创新点已作具体说明。", "创新点为空、为占位文字，或未说明动力/控制系统的具体改进。", evidenceFor(/创新点|innovation/iu)),
    outletItem,
    yesNoItem("sop_stages", 39, stagesPassed, "SOP 覆盖紧急、准备、行驶、停止、距离调整、清洁及赛后处置等关键阶段。", "SOP 未覆盖全部关键阶段，或紧急处置步骤超过两步而不利于现场快速执行。", evidenceFor(/标准\s*\/?\s*安全操作|standard\s+(?:safe\s+)?operating/iu)),
    yesNoItem("sop_four_columns", 39, fourColumnsPassed, "SOP 已填写步骤顺序、潜在危险、风险控制和个人防护四类信息。", "SOP 缺少步骤顺序、潜在危险、控制风险步骤或个人防护用品/设备中的一类或多类。", evidenceFor(/步骤顺序|step\s+sequence/iu)),
    yesNoItem("sop_quantification", 39, quantified, "SOP 已检出实际化学品及带质量/体积单位的加料用量，未检出模糊配方措辞；浓度、温度或设备参数不能代替加料用量。", containsVagueQuantity ? "SOP 使用了“适量/一定比例/特定配方”等模糊表述，请补充可执行的药品质量、溶液体积和配制条件。" : "SOP 未检出带质量或体积单位的实际加料用量；只写浓度、温度或时间不足以安全复现配制过程。", evidenceFor(/标准\s*\/?\s*安全操作|适量|按需|mol\s*\/\s*L|mL|℃/iu)),
    yesNoItem("waste_handling_detail", 40, wastePassed, "废物成分/危害、容器、标签、相容性和最终去向均已说明。", unsafeDischarge ? "现场化学废液不能直接倒入水槽或下水道，应分类收集、贴标签并交给赛事指定废物流或有资质机构。" : "废物处理缺少废物成分或危害、盛装容器、标签、相容性/不得混合要求或最终处置去向。", evidenceFor(/废物处理|waste\s+(?:handling|disposal)/iu)),
    historyItem,
  ];
  return unreadableCore ? results.map(result => ({ ...result, status: "needs_human" as const,
    suggestedComment: "中英文正文均无法可靠读取，不能把文字未提取到当作缺项；请核对原 PDF 后重新审核。" })) : results;
}
