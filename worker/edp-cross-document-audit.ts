import type {
  EdpDocumentRole,
  EdpPageVisualSignal,
  EdpReviewDocument,
  EdpReviewEvidence,
  EdpReviewStatus,
} from "./edp-review-rules";

const BUILTIN_RULE_SOURCE = "builtin:v1";

export const EDP_CROSS_DOCUMENT_RULE_IDS = Object.freeze([
  "hazard_types",
  "jsa",
  "safeguards",
  "risks_and_mitigations",
  "rule_violations",
  "chemical_sds",
  "ppe",
  "certification_signatures",
  "moc",
  "hazards_analysis_completed",
  "laboratory_floor_plan",
  "primary_hazards_checklist",
  "training_certificate_coverage",
  "equipment_list_completeness",
  "hydrogen_calculation_applicability",
  "pressure_calculation_applicability",
  "max_pressure_500psig",
  "mawp_gt_mop",
  "capital_cost_completeness",
  "waste_tag_consistency",
] as const);

export interface CrossDocumentAuditContext {
  submissionRound: 1 | 2 | 3 | 4 | 5;
  competitionYear?: string;
}

export interface CrossDocumentAuditItem {
  ruleId: (typeof EDP_CROSS_DOCUMENT_RULE_IDS)[number];
  row: number;
  status: EdpReviewStatus;
  isBlocking: boolean;
  ruleSource: string;
  worksheetName: "2) EDP Evaluation";
  suggestedComment: string;
  evidence: EdpReviewEvidence[];
}

interface LocatedPage {
  document: EdpReviewDocument;
  pageIndex: number;
  text: string;
  signal: EdpPageVisualSignal;
}

const EMPTY_SIGNAL: EdpPageVisualSignal = Object.freeze({
  imageCount: 0,
  annotationCount: 0,
  pathPaintCount: 0,
});

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function normalizedKey(value: string): string {
  return normalizeText(value).toLocaleLowerCase("en-US").replace(/[\s._—–-]+/gu, "");
}

function safeTest(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

function findPages(documents: readonly EdpReviewDocument[], roles: readonly EdpDocumentRole[], patterns: readonly RegExp[]): LocatedPage[] {
  const pages: LocatedPage[] = [];
  for (const document of documents) {
    if (!roles.includes(document.role)) continue;
    for (let pageIndex = 0; pageIndex < document.pages.length; pageIndex += 1) {
      const text = document.pages[pageIndex] ?? "";
      if (!patterns.some((pattern) => safeTest(pattern, text))) continue;
      pages.push({
        document,
        pageIndex,
        text,
        signal: document.pageSignals?.[pageIndex] ?? EMPTY_SIGNAL,
      });
    }
  }
  return pages;
}

function followingSectionPages(
  document: EdpReviewDocument,
  startPatterns: readonly RegExp[],
  maximumPageCount: number,
  endPatterns: readonly RegExp[] = [],
): LocatedPage[] {
  const start = document.pages.findIndex((page) => startPatterns.some((pattern) => safeTest(pattern, page)));
  if (start < 0) return [];
  const pages: LocatedPage[] = [];
  for (let pageIndex = start; pageIndex < Math.min(document.pages.length, start + maximumPageCount); pageIndex += 1) {
    const text = document.pages[pageIndex] ?? "";
    if (pageIndex > start && endPatterns.some((pattern) => safeTest(pattern, text))) break;
    pages.push({ document, pageIndex, text, signal: document.pageSignals?.[pageIndex] ?? EMPTY_SIGNAL });
  }
  return pages;
}

function trailingSectionPages(
  document: EdpReviewDocument,
  startPatterns: readonly RegExp[],
  maximumPageCount: number,
  endPatterns: readonly RegExp[] = [],
): LocatedPage[] {
  let start = -1;
  for (let pageIndex = 0; pageIndex < document.pages.length; pageIndex += 1) {
    if (startPatterns.some((pattern) => safeTest(pattern, document.pages[pageIndex] ?? ""))) start = pageIndex;
  }
  if (start < 0) return [];
  const pages: LocatedPage[] = [];
  for (let pageIndex = start; pageIndex < Math.min(document.pages.length, start + maximumPageCount); pageIndex += 1) {
    const text = document.pages[pageIndex] ?? "";
    if (pageIndex > start && endPatterns.some((pattern) => safeTest(pattern, text))) break;
    pages.push({ document, pageIndex, text, signal: document.pageSignals?.[pageIndex] ?? EMPTY_SIGNAL });
  }
  return pages;
}

function truncate(value: string, limit = 260): string {
  const normalized = normalizeText(value);
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

function evidenceFor(pages: readonly LocatedPage[]): EdpReviewEvidence[] {
  return pages.slice(0, 8).map(({ document, pageIndex, text, signal }) => {
    const visual = [
      signal.imageCount ? `${signal.imageCount} 个图像对象` : "",
      signal.annotationCount ? `${signal.annotationCount} 个批注` : "",
      signal.pathPaintCount ? `${signal.pathPaintCount} 个路径绘制` : "",
    ].filter(Boolean).join("、");
    const excerpt = truncate(text);
    return {
      documentRole: document.role,
      filename: document.filename,
      page: pageIndex + 1,
      excerpt: [excerpt, visual ? `页面视觉信号：${visual}` : ""].filter(Boolean).join("；"),
    };
  });
}

function item(
  ruleId: CrossDocumentAuditItem["ruleId"],
  row: number,
  status: EdpReviewStatus,
  suggestedComment: string,
  pages: readonly LocatedPage[],
): CrossDocumentAuditItem {
  return {
    ruleId,
    row,
    status,
    isBlocking: true,
    ruleSource: BUILTIN_RULE_SOURCE,
    worksheetName: "2) EDP Evaluation",
    suggestedComment,
    evidence: evidenceFor(pages),
  };
}

function hasVisualSignal(page: LocatedPage): boolean {
  return page.signal.imageCount > 0 || page.signal.annotationCount > 0 || page.signal.pathPaintCount > 0;
}

function extractLabeledSection(value: string, label: RegExp, nextLabels: readonly RegExp[]): string {
  const labelMatch = value.match(label);
  if (!labelMatch || labelMatch.index === undefined) return "";
  const remainder = value.slice(labelMatch.index + labelMatch[0].length);
  let endIndex = remainder.length;
  for (const nextLabel of nextLabels) {
    const nextMatch = remainder.match(nextLabel);
    if (nextMatch?.index !== undefined) endIndex = Math.min(endIndex, nextMatch.index);
  }
  return normalizeText(remainder.slice(0, endIndex)).replace(/^[_＿.\-|—–:：\s]+|[_＿.\-|—–:：\s]+$/gu, "");
}

function hasMeaningfulMocEntry(value: string): boolean {
  const content = normalizeText(value).replace(/[_＿.\-|—–:：□☐☑✓✔\s]/gu, "");
  return content.length >= 5 && !/^(?:n\/?a|notapplicable|none|不适用|无)$/iu.test(content);
}

function unreadableVisualPages(documents: readonly EdpReviewDocument[], roles: readonly EdpDocumentRole[]): LocatedPage[] {
  return documents.filter((document) => roles.includes(document.role)).flatMap((document) =>
    document.pages.flatMap((text, pageIndex) => {
      const signal = document.pageSignals?.[pageIndex] ?? EMPTY_SIGNAL;
      return (signal.imageCount > 0 || signal.visualReadLimited) && normalizeText(text).length < 120
        ? [{ document, pageIndex, text, signal }] : [];
    }));
}

function coreDocuments(documents: readonly EdpReviewDocument[]): EdpReviewDocument[] {
  return documents.filter(({ role }) => role === "chinese_edp" || role === "english_edp");
}

function combinedText(documents: readonly EdpReviewDocument[], roles?: readonly EdpDocumentRole[]): string {
  return documents
    .filter((document) => !roles || roles.includes(document.role))
    .flatMap(({ pages }) => pages)
    .join("\n");
}

function sopSectionPages(document: EdpReviewDocument): LocatedPage[] {
  return followingSectionPages(document, [
    /标准\s*\/\s*安全操作页|标准安全操作(?:程序|页)?/iu,
    /Standard\s*\/\s*Safe\s+Operating\s+Procedures?\s+Page|Standard\s+(?:Safe\s+)?Operating\s+Procedure/iu,
  ], document.pages.length, [
    /\bEquipment\s*List\b|设备清单|历届比赛作品|近五年方案|Previous\s+(?:Five|5)\s+Years|Chemical\s+Information\s+Page/iu,
  ]);
}

function authoredOperatingText(pages: readonly LocatedPage[]): string {
  const text = pages.map(({ text: pageText }) => pageText).join("\n");
  const columns = /步骤顺序|Step\s+Sequence/iu.exec(text);
  return (columns ? text.slice(columns.index) : text)
    .replace(/更新于\s*20\d{2}\s*年\s*\d{1,2}\s*月\s*\d{1,3}/gu, "");
}

function currentChemicalText(documents: readonly EdpReviewDocument[]): string {
  return coreDocuments(documents).flatMap(document => {
    let early = document.pages.slice(0, 3).map(text => text.split(/历届比赛作品|近五年(?:方案|作品)|(?:Previous|Past)\s+(?:Five|5)\s+Years/iu)[0]);
    const inventoryIndex = early.findIndex(page => /Chemical\s+Information\s+Page/iu.test(page));
    if (inventoryIndex >= 0) early = early.slice(0, inventoryIndex + 1);
    const design = early.join("\n").replace(/(?:创新点|\bInnovation\b)[\s\S]*$/iu, "");
    return [design, authoredOperatingText(sopSectionPages(document))];
  }).join("\n");
}

function fullDateYears(value: string): string[] {
  return [...value.matchAll(/(?<!\d)(20\d{2})\s*(?:[./-]\s*\d{1,2}\s*[./-]|年\s*\d{1,2}\s*月)\s*\d{1,2}(?:\s*日)?(?!\d)/gu)]
    .map((match) => match[1]);
}

interface TrainingRoster {
  pages: LocatedPage[];
  dates: string[];
}

function trainingRoster(document: EdpReviewDocument): TrainingRoster {
  const startPatterns = [
    /Please\s+list\s+the\s+date\s+the\s+required\s+Chem-E-Car\s+safety\s+training/iu,
    /请列出每位团队成员完成所需\s*Chem-E-Car\s*安全培训的具体日期/iu,
    /Team\s+Member\s+Name\s+Date/iu,
    /团队成员姓名\s+日期/iu,
  ];
  const pageIndex = document.pages.findIndex((page) => startPatterns.some((pattern) => safeTest(pattern, page)));
  if (pageIndex < 0) return { pages: [], dates: [] };
  const text = document.pages[pageIndex] ?? "";
  const starts = startPatterns.map((pattern) => {
    pattern.lastIndex = 0;
    return pattern.exec(text)?.index ?? -1;
  }).filter((index) => index >= 0);
  const start = starts.length ? Math.max(...starts) : 0;
  const segment = text.slice(start);
  const end = segment.search(/(?:Faculty|学院)\s*(?:Safety\s+Rules\s+)?Certification|学院安全规则认证/iu);
  const rosterText = end >= 0 ? segment.slice(0, end) : segment;
  const pages: LocatedPage[] = [{
    document,
    pageIndex,
    text,
    signal: document.pageSignals?.[pageIndex] ?? EMPTY_SIGNAL,
  }];
  return { pages, dates: fullDateYears(rosterText) };
}

function bestTrainingRoster(documents: readonly EdpReviewDocument[]): TrainingRoster {
  return coreDocuments(documents)
    .map(trainingRoster)
    .sort((left, right) => right.dates.length - left.dates.length)[0] ?? { pages: [], dates: [] };
}

function advisorCount(documents: readonly EdpReviewDocument[]): number {
  for (const document of coreDocuments(documents)) {
    const cover = document.pages[0] ?? "";
    const match = /(?:Faculty\s+Supervisor|Faculty\s+Advisor(?:\s+Name)?|指导教师(?:姓名)?|指导老师(?:姓名)?)\s*[:：]\s*(.+?)(?=\s+(?:Supervisor\s+Email|Faculty\s+Advisor\s+Email|指导教师邮箱|指导老师邮箱|Revision|队长|Team\s+Captain)|[|;；]|$)/iu.exec(cover);
    if (!match?.[1]) continue;
    const names = normalizeText(match[1]).split(/[，,、;/]+/u).map((name) => name.trim()).filter(Boolean);
    if (names.length) return names.length;
  }
  return 1;
}

function auditCertificationSignatures(documents: readonly EdpReviewDocument[]): CrossDocumentAuditItem {
  const startPatterns = [
    /(?:(?:Faculty|Student)\s+)?Safety(?:\s+Rules)?\s+Certification|Certification\s+Page/iu,
    /安全(?:规则)?认证|认证页|签名|签字/iu,
  ];
  const candidates = coreDocuments(documents).map((document) => followingSectionPages(document, startPatterns, 3, [
    /Hazards?\s+Analysis|标准\/安全操作页|Standard\s*\/\s*Safe\s+Operating/iu,
  ])).filter(({ length }) => length > 0);
  const pages = candidates.flat();
  if (!pages.length) {
    return item("certification_signatures", 43, "no", "中文或英文 EDP 中均未检出必需的安全规则认证签名页；外部专家签名为可选项。", []);
  }
  const explicitlySigned = candidates.some((candidate) => candidate.every(({ text }) => (text.match(/\[(?:signed|已签)\]|(?:已签名|已签字)/giu) ?? []).length >= 2));
  if (explicitlySigned) {
    return item("certification_signatures", 43, "needs_human", "认证页检测到已签署文字标记，请人工核对是否为指导教师和全部参赛成员的手写签名；文字标记不能证明手写签名真实存在。", pages);
  }
  const roster = bestTrainingRoster(documents);
  const requiredSignatureCount = roster.dates.length + advisorCount(documents);
  const minimumDateCount = roster.dates.length + 1;
  for (const candidate of candidates) {
    const firstText = candidate[0]?.text ?? "";
    const starts = startPatterns.map((pattern) => {
      pattern.lastIndex = 0;
      return pattern.exec(firstText)?.index ?? -1;
    }).filter((index) => index >= 0);
    const firstStart = starts.length ? Math.min(...starts) : 0;
    const certificationText = [firstText.slice(firstStart), ...candidate.slice(1).map(({ text }) => text)].join("\n");
    const visualSignatureCount = candidate.reduce((sum, page) => sum + page.signal.imageCount, 0);
    const certificationDates = fullDateYears(certificationText).length;
    const declaresExperience = /(?:at\s+least|minimum\s+of)\s+ten\s+hours|至少\s*10\s*(?:个)?小时/iu.test(certificationText);
    if (roster.dates.length >= 1
      && declaresExperience
      && visualSignatureCount >= requiredSignatureCount
      && certificationDates >= minimumDateCount) {
      return item(
        "certification_signatures",
        43,
        "yes",
        `已在${candidate[0].document.role === "chinese_edp" ? "中文" : "英文"} EDP 认证页检出指导教师及 ${roster.dates.length} 名成员对应的手写签名图像和日期，并明确声明至少 10 小时操作经验；另一语言版本无需重复签署，外部专家签名为可选项。`,
        [...candidate, ...roster.pages],
      );
    }
  }
  if (pages.every((page) => !hasVisualSignal(page))) {
    return item("certification_signatures", 43, "no", "认证页未检测到手写签名的图像、批注或路径证据，请补齐指导教师和全部参赛成员签名。", pages);
  }
  const candidateSummary = candidates.map((candidate) => {
    const text = candidate.map((page) => page.text).join("\n");
    const images = candidate.reduce((sum, page) => sum + page.signal.imageCount, 0);
    return `${candidate[0].document.role === "chinese_edp" ? "中文" : "英文"}版图像 ${images}、日期 ${fullDateYears(text).length}`;
  }).join("；");
  return item("certification_signatures", 43, "needs_human", `认证页含手写/图形视觉信号，但签名图像、成员名单或日期未达到可逐项对应的条件（成员 ${roster.dates.length}、需签名 ${requiredSignatureCount}；${candidateSummary}），请人工查看；中文或英文任一版本签署完整即可，外部专家签名为可选项。`, [...pages, ...roster.pages]);
}

function auditHazardsAnalysis(documents: readonly EdpReviewDocument[]): CrossDocumentAuditItem {
  const english = documents.find(({ role }) => role === "english_edp");
  const pages = english ? followingSectionPages(
    english,
    [/\bHazards?\s+Analysis\b/iu],
    7,
    [/\bChemical\s+Information\s+Page\b/iu],
  ) : [];
  if (!pages.length) {
    return item("hazards_analysis_completed", 30, "no", "英文版缺少 Hazards Analysis；该章节是英文模板专属，不要求中文版提供。", []);
  }
  const sectionText = pages.map(({ text }) => text).join("\n");
  const consequenceNarrative = /hazard|risk/iu.test(sectionText)
    && /consequence|effect|injury|burn|exposure/iu.test(sectionText)
    && /control|prevent|mitigat|goggle|glove/iu.test(sectionText);
  const completedHazardTable = /Hazard\s+Present\s+During|Additional\s+Fabrication\s*&\s*Operation\s+Hazard/iu.test(sectionText)
    && /Control\s+Method|PPE\s+Required/iu.test(sectionText)
    && /\bYes\b.{0,180}(?:control|contain|guard|goggle|glove|insulat|fume\s+hood)/isu.test(sectionText);
  const populatedOperatingContext = /Expected\s+Operating\s+Conditions/iu.test(sectionText)
    && /Personal\s+Protective\s+Equipment|\bPPE\b/iu.test(sectionText)
    && /Available\s+Safety\s+Equipment/iu.test(sectionText)
    && /(?:Fire\s+Extinguisher|Eyewash|Safety\s+Shower)\s*[:：]\s*(?!N\/?A\b)\S/iu.test(sectionText);
  const populatedHazardControls = /Additional\s+Fabrication\s*&\s*Operation\s+Hazard/iu.test(sectionText)
    && /Control\s+Method(?:\(s\))?|PPE\s+Required/iu.test(sectionText)
    && /(?:prevent|avoid|insulat|contain|reinforc|keep\s+away|disconnect|guard|seal)/iu.test(sectionText)
    && /(?:goggle|glove|mask|protective|PPE)/iu.test(sectionText);
  const complete = normalizeText(sectionText).length >= 160
    && (consequenceNarrative || completedHazardTable || (populatedOperatingContext && populatedHazardControls));
  return item(
    "hazards_analysis_completed",
    30,
    complete ? "yes" : "no",
    complete
      ? "英文版危险分析已填写危险、可能后果和控制措施；中文版模板没有该章节，不参与此项检查。"
      : "英文版 Hazards Analysis 未同时说明危险、后果和控制措施；中文版模板没有该章节，不参与此项检查。",
    pages,
  );
}

function auditLaboratoryFloorPlan(documents: readonly EdpReviewDocument[]): CrossDocumentAuditItem {
  const pages = findPages(documents, ["english_edp"], [/\bLaboratory\s+(?:Floor\s+Plan|Layout)\b/iu]);
  if (!pages.length) {
    return item("laboratory_floor_plan", 36, "no", "英文版缺少 Laboratory Floor Plan；该章节是英文模板专属，不要求中文版提供。", []);
  }
  if (pages.some((page) => page.signal.imageCount > 0)) {
    return item("laboratory_floor_plan", 36, "yes", "英文版 Laboratory Floor Plan 专页已检出实际嵌入的平面图图像，满足平面图存在性检查；中文版模板没有该章节。", pages);
  }
  if (pages.every((page) => !hasVisualSignal(page))) {
    return item("laboratory_floor_plan", 36, "no", "英文版实验室平面图页只有标题或空白框，未检测到图像/绘图内容；中文版模板没有该章节。", pages);
  }
  return item("laboratory_floor_plan", 36, "needs_human", "英文版实验室平面图页含路径或批注，但未检出独立嵌入图像，需人工确认是否确有平面图；中文版模板没有该章节。", pages);
}

function auditPrimaryHazardsChecklist(documents: readonly EdpReviewDocument[]): CrossDocumentAuditItem {
  const english = documents.find(({ role }) => role === "english_edp");
  const pages = english ? followingSectionPages(english, [/\bVehicle\s+Primary\s+Hazards?\s+Checklist\b/iu], 3, [
    /\bAdditional\s+Fabrication\s*&\s*Operation\s+Hazard/iu,
  ]) : [];
  if (!pages.length) {
    return item("primary_hazards_checklist", 29, "no", "英文版缺少 Vehicle Primary Hazards Checklist；该章节是英文模板专属，不要求中文版提供。", []);
  }
  const checklistText = pages.map(({ text }) => text).join("\n");
  const laterEnglishPages = findPages(documents, ["english_edp"], [/mechanical\s+hazards?.{0,32}(?:yes|present)|other\s+mechanical\s+hazards?.{0,16}yes/iu]);
  const mechanicalUnchecked = /mechanical\s+hazards?\s*[:：]?\s*(?:\[\s*\]|☐|no\b)/iu.test(checklistText);
  if (mechanicalUnchecked && laterEnglishPages.length) {
    return item("primary_hazards_checklist", 29, "no", "英文版主要危险清单将机械危险留空/标为否，但后续危险页明确填写机械危险为 Yes，请按实际方案修正清单。", [...pages, ...laterEnglishPages]);
  }
  const explicitMarks = /\[(?:x|X|✓)\]|☑|☒/u.test(checklistText);
  if (explicitMarks && !laterEnglishPages.length) {
    return item("primary_hazards_checklist", 29, "yes", "英文版主要危险清单检测到明确勾选标记，且未发现与后续危险说明的客观矛盾。", pages);
  }
  const pathCount = pages.reduce((sum, page) => sum + page.signal.pathPaintCount, 0);
  const supportingHazards = findPages(documents, ["english_edp"], [
    /Additional\s+Fabrication\s*&\s*Operation\s+Hazard[\s\S]{0,220}(?:Control\s+Method|PPE\s+Required)/iu,
    /Hazards?\s+inherent\s+in\s+design[\s\S]{0,400}(?:prevent|mitigat|control)/iu,
  ]);
  if (pathCount >= 80 && supportingHazards.length) {
    return item("primary_hazards_checklist", 29, "yes", "英文版主要危险清单检出已填写的表格绘制信号，并在后续危险分析中找到对应控制方法/PPE，未发现客观矛盾。", [...pages, ...supportingHazards]);
  }
  return item("primary_hazards_checklist", 29, "needs_human", "英文版主要危险清单存在，但勾选状态不能从 PDF 文字/绘图信号中可靠还原，请人工核对，并与后续危险分析保持一致；中文版模板没有该章节。", [...pages, ...laterEnglishPages]);
}

interface ChemicalDefinition {
  id: string;
  label: string;
  patterns: readonly RegExp[];
  sdsExempt?: boolean;
}

const CHEMICALS: readonly ChemicalDefinition[] = Object.freeze([
  { id: "zinc", label: "锌（zinc）", patterns: [/\bzinc\b(?!\s+(?:sulfate|sulphate|chloride|oxide|acetate))|(?<!氯化|硫酸|氧化|醋酸|乙酸)锌/iu] },
  { id: "ethanol", label: "乙醇（ethanol）", patterns: [/\bethanol\b|乙醇/iu] },
  { id: "sodium_hydroxide", label: "氢氧化钠（sodium hydroxide）", patterns: [/sodium\s+hydroxide|氢氧化钠|\bNaOH\b/iu] },
  { id: "potassium_hydroxide", label: "氢氧化钾（KOH）", patterns: [/potassium\s+hydroxide|氢氧化钾|\bKOH\b/iu] },
  { id: "hydrochloric_acid", label: "盐酸（hydrochloric acid）", patterns: [/hydrochloric\s+acid|盐酸|\bHCl\b/iu] },
  { id: "potassium_ferricyanide", label: "铁氰化钾（potassium ferricyanide）", patterns: [/potassium\s+ferricyanide|铁氰化钾|\bK3Fe\(CN\)6\b/iu] },
  { id: "nickel_sulfate", label: "硫酸镍（nickel sulfate）", patterns: [/nickel\s+sulfate|硫酸镍|\bNiSO4\b/iu] },
  { id: "zinc_oxide", label: "氧化锌（ZnO）", patterns: [/zinc\s+oxide|氧化锌|\bZnO\b/iu] },
  { id: "citric_acid", label: "柠檬酸（citric acid）", patterns: [/citric\s+acid|柠檬酸/iu] },
  { id: "oxalic_acid", label: "草酸（oxalic acid）", patterns: [/oxalic\s+acid|草酸/iu] },
  { id: "glucono_delta_lactone", label: "葡萄糖酸内酯（GDL）", patterns: [/glucono[-\s]*(?:delta|δ)?[-\s]*lactone|葡萄糖酸(?:δ|delta)?内酯|\bGDL\b/iu] },
  { id: "copper_sulfate", label: "硫酸铜（CuSO4，需核对水合形态）", patterns: [/copper\s*(?:\(?II\)?\s*)?sul(?:f|ph)ate|硫酸铜|\bCuSO\s*4\b/iu] },
  { id: "aluminum_chloride", label: "氯化铝（AlCl3，需核对无水/水合形态）", patterns: [/alumin(?:um|ium)\s+chloride(?!\s+hexahydrate)|(?<!六水合)氯化铝|\bAlCl3\b(?!\s*[·.]?\s*6\s*H2O)/iu] },
  { id: "aluminum_chloride_hexahydrate", label: "六水合氯化铝", patterns: [/alumin(?:um|ium)\s+chloride\s+hexahydrate|六水合氯化铝|AlCl3\s*[·.]\s*6\s*H2O/iu] },
  { id: "potassium_iodate", label: "碘酸钾（KIO3）", patterns: [/potassium\s+iodate|碘酸钾|\bKIO3\b/iu] },
  { id: "potassium_iodide", label: "碘化钾（KI）", patterns: [/potassium\s+iodide|碘化钾|\bKI\b/iu] },
  { id: "sodium_sulfite", label: "亚硫酸钠（Na2SO3）", patterns: [/sodium\s+sul(?:f|ph)ite|(?<!焦)亚硫酸钠|\bNa2SO3\b/iu] },
  { id: "sodium_bisulfite", label: "亚硫酸氢钠（NaHSO3）", patterns: [/sodium\s+(?:bisul(?:f|ph)ite|hydrogen\s+sul(?:f|ph)ite)|亚硫酸氢钠|\bNaHSO3\b/iu] },
  { id: "sodium_metabisulfite", label: "焦亚硫酸钠（Na2S2O5）", patterns: [/sodium\s+metabisul(?:f|ph)ite|焦亚硫酸钠|\bNa2S2O5\b/iu] },
  { id: "sodium_thiosulfate", label: "硫代硫酸钠（Na2S2O3）", patterns: [/sodium\s+thiosul(?:f|ph)ate|硫代硫酸钠|\bNa2S2O3\b/iu] },
  { id: "sodium_persulfate", label: "过硫酸钠（Na2S2O8）", patterns: [/sodium\s+persul(?:f|ph)ate|过硫酸钠|\bNa2S2O8\b/iu] },
  { id: "potassium_persulfate", label: "过硫酸钾（K2S2O8）", patterns: [/potassium\s+persul(?:f|ph)ate|过硫酸钾|\bK2S2O8\b/iu] },
  { id: "starch", label: "淀粉（starch）", patterns: [/\bstarch\b|淀粉/iu] },
  { id: "hydrogen_peroxide", label: "过氧化氢（H2O2）", patterns: [/hydrogen\s+peroxide|过氧化氢|\bH2O2\b/iu] },
  { id: "sulfuric_acid", label: "硫酸（H2SO4）", patterns: [/sul(?:f|ph)uric\s+acid|(?<!亚|连二|硫代)硫酸(?!氢|锌|镍|锰|铜|钠|钾|铝|铁|钙|铵|铅|银|钡|钴|盐)|\bH2SO4\b/iu] },
  { id: "zinc_sulfate", label: "硫酸锌（ZnSO4）", patterns: [/zinc\s+sul(?:f|ph)ate|硫酸锌|\bZnSO4\b/iu] },
  { id: "manganese_sulfate", label: "硫酸锰（MnSO4）", patterns: [/manganese\s+sul(?:f|ph)ate|硫酸锰|\bMnSO4\b/iu] },
  { id: "agar", label: "琼脂（agar）", patterns: [/\bagar\b|琼脂/iu] },
  { id: "carbon", label: "碳（carbon）", patterns: [/\bcarbon\b(?!\s+(?:black|dioxide|monoxide))|(?<!二氧化|一氧化|炭黑)碳(?!黑)/iu] },
  { id: "carbon_black", label: "炭黑（carbon black）", patterns: [/carbon\s+black|炭黑/iu] },
  { id: "ethyl_lactate", label: "乳酸乙酯（ethyl lactate）", patterns: [/ethyl\s+lactate|乳酸乙酯/iu] },
  { id: "thymolphthalein", label: "百里酚酞（thymolphthalein）", patterns: [/thymolphthalein|百里酚酞/iu] },
  { id: "magnesium", label: "镁（magnesium）", patterns: [/(?<!氯化|氧化|锰酸|合金)镁(?!\s*(?:合金|锰\s*电?\s*池))|\bmagnesium\b(?!\s*(?:chloride|hydroxide|alloy|oxide|-\s*manganese\b))/iu] },
  { id: "ptfe", label: "聚四氟乙烯（PTFE）", patterns: [/polytetrafluoroethylene|聚四氟乙烯|\bPTFE\b/iu] },
  { id: "magnesium_chloride", label: "氯化镁（magnesium chloride）", patterns: [/magnesium\s+chloride|氯化镁|\bMgCl2\b/iu] },
  { id: "tartaric_acid", label: "酒石酸（tartaric acid）", patterns: [/tartaric\s+acid|酒石酸|\bC4H6O6\b/iu] },
  { id: "potassium_permanganate", label: "高锰酸钾（potassium permanganate）", patterns: [/potassium\s+permanganate|高锰酸钾|\bKMnO4\b/iu] },
  { id: "iron_iii_chloride", label: "三氯化铁（iron(III) chloride）", patterns: [/iron\s*\(?iii\)?\s+chloride|iron\s*\([^)]{0,8}\)\s+chloride|ferric\s+chloride|三氯化铁|氯化铁|\bFeCl3\b/iu] },
  { id: "manganese_iv_oxide", label: "二氧化锰（manganese(IV) oxide）", patterns: [/manganese\s*\(?iv\)?\s+oxide|manganese\s+dioxide|二氧化锰|\bMnO2\b/iu] },
  { id: "nickel", label: "镍（nickel）", patterns: [/(?<!硫酸|泡沫)镍|\bnickel\b(?!\s+(?:sulfate|foam))/iu] },
  { id: "water", label: "水（water）", patterns: [/\bwater\b|(?<!废)水|\bH2O\b/iu], sdsExempt: true },
]);

function chemicalIds(text: string): Set<string> {
  const normalized = normalizeText(text);
  return new Set(CHEMICALS
    .filter(({ patterns }) => patterns.some((pattern) => safeTest(pattern, normalized)))
    .map(({ id }) => id));
}

function chemicalLabels(ids: readonly string[]): string[] {
  return ids.map((id) => CHEMICALS.find((chemical) => chemical.id === id)?.label ?? id);
}

function englishChemicalInformationPages(documents: readonly EdpReviewDocument[]): LocatedPage[] {
  const english = documents.find(({ role }) => role === "english_edp");
  if (!english) return [];
  const start = english.pages.findIndex((page) => /\bChemical\s*Information\s*(?:Page|Table)\b/iu.test(page));
  if (start < 0) return [];
  const located: LocatedPage[] = [];
  for (let index = start; index < english.pages.length; index += 1) {
    const text = english.pages[index] ?? "";
    if (index > start && /\bChemical\s*(?:Properties\s*and\s*Hazards|Hazards\s*and\s*Disposal)\b|\bEquipment\s*List\b|\bDischarged\s*Hydrogen\b|\bPressure\s*Calculations\b|\bStandard\s*\/\s*Safe\s*Operating/iu.test(text)) break;
    located.push({ document: english, pageIndex: index, text, signal: english.pageSignals?.[index] ?? EMPTY_SIGNAL });
  }
  return located;
}

function allSupplementPages(documents: readonly EdpReviewDocument[]): LocatedPage[] {
  return documents.filter(({ role }) => role === "supplement").flatMap((document) =>
    document.pages.map((text, pageIndex) => ({
      document,
      pageIndex,
      text,
      signal: document.pageSignals?.[pageIndex] ?? EMPTY_SIGNAL,
    })));
}

function isSupplementContentsPage(text: string): boolean {
  if (/目录|索引|\b(?:contents?|index)\b|另行下载|download.{0,30}(?:full|complete)/iu.test(text)
    && !/Product\s+(?:Name|Identifier)\s*[:：]|Chemical\s+(?:Name|Identity)\s*[:：]|化学品名称\s*[:：]|产品名称\s*[:：]|Section\s+2\b|第二部分/iu.test(text)) return true;
  const listedChemicalCount = chemicalIds(text).size;
  const dotLeaderCount = (text.match(/\.{4,}/gu) ?? []).length;
  return /\bCONTENTS?\b|\bCONTEXT\b|目录/iu.test(text)
    && (listedChemicalCount >= 3 || dotLeaderCount >= 2);
}

function sdsIdentityChemicals(page: LocatedPage): Set<string> {
  const text = normalizeText(page.text);
  // A reagent in the incompatibility, extinguishing-media or treatment prose
  // is not the identity of this SDS. Prefer product/chemical identity fields.
  const identityFields = [...text.matchAll(/(?:Product\s+(?:Name|Identifier)|Chemical\s+(?:Name|Identity)|化学品名称|产品名称)\s*[:：]\s*(.+?)(?=\||\b(?:CAS|Section|Composition|Hazards?|Incompatib)\b|[；;]|$)/giu)];
  if (identityFields.length) return chemicalIds(identityFields.map(match => match[1]).join("\n"));
  const headings = [...text.matchAll(/(?:Material\s+Safety\s+Data\s+Sheet|Safety\s+Data\s+Sheet|M?SDS|化学品安全技术说明书|安全数据表)\s*(?:\([^)]{0,16}\))?\s*[:：-]\s*([^.|；;]+)(?=[.|；;]|$)/giu)];
  if (headings.length) return chemicalIds(headings.map(match => match[1]).join("\n"));
  const bodyStart = text.search(/(?:\bSection\s*[2-9]\b|危险性概述|Incompatible|不相容|灭火措施|急救措施)/iu);
  return chemicalIds(bodyStart >= 0 ? text.slice(0, bodyStart) : text);
}

function actualSdsEvidencePages(documents: readonly EdpReviewDocument[]): LocatedPage[] {
  return allSupplementPages(documents).filter((page) => {
    const normalized = normalizeText(page.text);
    if (!chemicalIds(normalized).size || isSupplementContentsPage(normalized)) return false;
    const explicitSdsDocument = /\b(?:M?SDS|Safety\s+Data\s+Sheet|Material\s+Safety\s+Data\s+Sheet)\b|化学品安全技术说明书|安全数据表|危险性概述/iu.test(normalized);
    const sdsIdentityFields = /\bCAS(?:\s+(?:No\.?|Number))?\b|\bSECTION\s*1\b|Product\s+(?:Name|Identifier)|Chemical\s+(?:Name|Identity)|化学品名称|产品名称/iu.test(normalized);
    const picturedSectionHeading = page.signal.imageCount > 0
      && normalized.length <= 240
      && /^(?:Appendix\b.{0,60})?\s*\d{1,2}\s*[.)]?/iu.test(normalized);
    return explicitSdsDocument || sdsIdentityFields || picturedSectionHeading;
  });
}

function auditChemicalInventoryAndSds(documents: readonly EdpReviewDocument[]): CrossDocumentAuditItem {
  const core = coreDocuments(documents);
  const infoPages = englishChemicalInformationPages(documents);
  const supplementPages = actualSdsEvidencePages(documents);
  const inventoryPages = infoPages.filter(({ text }) => !/Chemical\s+Hazards\s+and\s+Disposal|Chemical\s+Properties\s+and\s+Hazards/iu.test(text));
  // Restrict "used chemicals" to operational descriptions and inventory/waste
  // tables.  Incompatibility prose may name acids or reagents that are not
  // actually present in the team's process.
  const inventoryText = inventoryPages
    .map(({ text }) => text.replace(/Incompatible\s+Chemicals?.*$/giu, ""))
    .join("\n");
  const currentOperationalText = currentChemicalText(documents);
  if (/(?<!禁止|不|未)(?:使用|采用|配备)[^,，。；;\n]{0,24}(?:铅酸蓄电池|铅酸电池|含铅电池)|(?:use|using|powered\s+by)[^.;\n]{0,24}lead[-\s]?acid\s+batter/iu.test(currentOperationalText)) {
    return item("chemical_sds", 5, "no", "当前设计中明确使用铅酸/含铅电池，不能因提供其他物质 SDS 而判此项通过。", findPages(documents, ["chinese_edp", "english_edp"], [/铅酸|含铅电池|lead[-\s]?acid/iu]));
  }
  const used = chemicalIds(`${currentOperationalText}\n${inventoryText}`);
  const info = chemicalIds(inventoryText);
  const sds = new Set(supplementPages.flatMap(page => [...sdsIdentityChemicals(page)]));
  const required = [...used].filter((id) => !CHEMICALS.find((chemical) => chemical.id === id)?.sdsExempt);
  const missingInfo = required.filter((id) => !info.has(id));
  const missingSds = required.filter((id) => !sds.has(id));
  const evidence = [...supplementPages, ...infoPages];
  if (core.some(({ textQuality }) => textQuality !== "usable")
    || documents.some(({ role, textQuality }) => role === "supplement" && textQuality !== "usable")) {
    return item("chemical_sds", 5, "needs_human", "中文版、英文版或增补文件的文字无法可靠提取，Chemical Information 与 SDS 覆盖需人工核对。", evidence);
  }
  if (!infoPages.length) {
    return item("chemical_sds", 5, "no", "英文版缺少 Chemical Information Page；该章节是英文模板专属，不要求中文版提供。", evidence);
  }
  if (!required.length) {
    return item("chemical_sds", 5, "needs_human", "未能可靠识别实际使用的化学物质，请人工核对 Chemical Information Page 与增补文件 SDS。", evidence);
  }
  const copperForms=["7758-98-7","7758-99-8"];
  const copperIdentityPages=supplementPages.filter(page=>sdsIdentityChemicals(page).has("copper_sulfate"));
  const identityCas=(page: LocatedPage): string[] => {
    const identity=normalizeText(page.text).split(/\bSection\s*[2-9]\b|第二部分|危险性概述|Incompatible|不相容|Other\s+(?:chemical\s+)?reference/iu)[0];
    return [...identity.matchAll(/CAS\s*(?:No\.?|Number|编号)?\s*[:：]?\s*(\d{2,7}-\d{2}-\d)\b/giu)].map(match=>match[1]);
  };
  const requiredCopper=info.has("copper_sulfate")?copperForms.filter(cas=>inventoryText.includes(cas)):[];
  const suppliedCopper=new Set(copperIdentityPages.flatMap(identityCas));
  const missingCopper=requiredCopper.filter(cas=>!suppliedCopper.has(cas));
  if (missingCopper.length && copperForms.some(cas=>suppliedCopper.has(cas))) {
    const unreadable = unreadableVisualPages(documents, ["supplement"]);
    return item("chemical_sds",5,unreadable.length ? "needs_human" : "no",
      "运输表硫酸铜的 CAS "+requiredCopper.join("、")+" 与 SDS 产品身份不对应；无水物 CAS 7758-98-7 和五水合物 CAS 7758-99-8 不能默认为同一运输物质。请按实际水合形态统一名称、CAS 和 SDS；其他章节的 CAS 引用不能代替产品身份，扫描页未辨认时不能断言正确 SDS 一定缺失。",
      [...inventoryPages,...copperIdentityPages]);
  }
  if (missingInfo.length || missingSds.length) {
    const parts = [
      missingInfo.length ? `Chemical Information Page 未覆盖：${chemicalLabels(missingInfo).join("、")}` : "",
      missingSds.length ? `增补文件实际 SDS 正文或分节页未检出：${chemicalLabels(missingSds).join("、")}` : "",
    ].filter(Boolean);
    const imagePages = [...unreadableVisualPages(documents, ["supplement"]),
      ...infoPages.filter((page) => page.signal.imageCount > 0 && normalizeText(page.text).length < 120)];
    if (imagePages.length) return item("chemical_sds", 5, "needs_human", `${parts.join("；")}。部分页面为文字不可读的图像，尚不能确认缺失，请查看图像页核对。普通用水不强制要求 SDS。`, [...imagePages, ...evidence]);
    return item("chemical_sds", 5, "no", `${parts.join("；")}。普通用水不强制要求 SDS。`, evidence);
  }
  return item("chemical_sds", 5, "yes", `已逐项核对 ${required.length} 种实际化学品：${chemicalLabels(required).join("、")}；均在英文版 Chemical Information Page 和增补文件实际 SDS 正文或分节页中找到对应证据。普通用水不强制要求 SDS。`, evidence);
}

function auditPpe(documents: readonly EdpReviewDocument[]): CrossDocumentAuditItem {
  const pages = findPages(documents, ["chinese_edp", "english_edp"], [
    /个人防护|护目镜|防护眼镜|手套|实验服|实验衣|面罩|口罩|Personal\s+Protective|\bPPE\b|goggles?|gloves?|lab\s+coats?|face\s+shields?/iu,
  ]);
  const refused = pages.filter(({ document, text }) => document.textQuality === "usable"
    && /(?<!禁止|不得|不应)(?:不佩戴|不穿戴|无需).{0,20}(?:个人防护|PPE|护目镜|手套|实验服)|do\s+not\s+wear.{0,30}(?:goggles?|gloves?|lab\s+coat)/iu.test(text));
  if (refused.length) return item("ppe", 6, "no", "操作说明明确不使用所列个人防护用品，请按实际化学品与操作风险补充适当防护；其他正向描述不能抵消此处矛盾。", refused);
  const filled = pages.filter(({ document, text }) => {
    if (document.textQuality !== "usable") return false;
    const authored = text.replace(/(?:\[\s*\]|☐|□)\s*(?:Gloves?|Goggles?|Lab\s+coat|Face\s+shield|手套|护目镜|实验服)/giu, "");
    const positiveAction = /(?:佩戴|穿戴|穿着|戴上|穿上).{0,60}(?:护目镜|防护眼镜|手套|实验服|实验衣|面罩|口罩)|\b(?:wear|wearing|use)\b.{0,60}(?:goggles?|gloves?|lab\s+coat|face\s+shield)/iu.test(authored);
    const filledField = /(?:PPE(?:\s+Required)?|Personal\s+Protective\s+Equipment|个人防护用品(?:或设备)?)\s*[:：|]\s*(?:[^\[\]☐□；;\n]{0,50})(?:goggles?|gloves?|lab\s+coat|护目镜|手套|实验服)/iu.test(authored);
    const checkedItem = /(?:\[(?:x|✓)\]|☑|☒)\s*(?:gloves?|goggles?|lab\s+coat|手套|护目镜|实验服)/iu.test(authored);
    return positiveAction || filledField || checkedItem;
  });
  if (filled.length) return item("ppe", 6, "yes", "已在中文或英文 EDP 的操作/防护说明中找到明确填写的个人防护用品；另一语言版本的未勾选模板不抵消已填写的证据。", filled);
  return item("ppe", 6, "needs_human", pages.length
    ? "已定位个人防护栏目，但只有未勾选选项或无法确认是实际填写的内容；不能把空模板当作已落实防护用品。"
    : "未能定位可可靠读取的个人防护说明，请核对操作页及防护栏目。", pages);
}

function uniqueNames(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = normalizedKey(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function auditTrainingCertificates(
  documents: readonly EdpReviewDocument[],
  competitionYear: CrossDocumentAuditContext["competitionYear"],
): CrossDocumentAuditItem {
  const roster = bestTrainingRoster(documents);
  const certificatePages = documents.filter(({ role }) => role === "supplement").flatMap((document) => trailingSectionPages(document, [
    /(?:Appendix|附录)\s*(?:III|Ⅲ|3).{0,80}(?:Security|Safety|Training|Certificate|安全|培训|证书)/iu,
    /AIChE.{0,50}(?:Certificate|Training|Safety\s+Course)|ChemE\s+Car\s+Safety\s+Course|Certificate\s+of\s+Completion|安全培训证书/iu,
  ], 80, [/(?:Appendix|附录)\s*(?:IV|Ⅳ|4)\b/iu]));
  if (!certificatePages.length) {
    const scannedSupplementPages = unreadableVisualPages(documents, ["supplement"]);
    if (scannedSupplementPages.length) {
      return item("training_certificate_coverage", 43, "needs_human", "增补文件包含文字不可读的扫描图像页，无法排除其中存在培训证书；不能因文字未检出直接判为缺失。", scannedSupplementPages);
    }
    return item("training_certificate_coverage", 43, "no", "EDP 增补文件中未检出 AIChE 安全培训证书章节。", []);
  }
  if (!/^20\d{2}$/u.test(competitionYear ?? "")) {
    return item("training_certificate_coverage", 43, "needs_human", "已检出安全培训证书，但审核设置中缺少有效竞赛年份，暂不能核对证书日期。", [...roster.pages, ...certificatePages]);
  }
  if (!roster.dates.length) {
    return item("training_certificate_coverage", 43, "needs_human", "已检出安全培训证书，但未能从中英文 EDP 的培训名单提取每位成员完成日期，无法核对人数和年份。", [...roster.pages, ...certificatePages]);
  }
  const wrongRosterYears = [...new Set(roster.dates.filter((year) => year !== competitionYear))];
  if (wrongRosterYears.length) {
    return item("training_certificate_coverage", 43, "no", `培训名单中检出 ${wrongRosterYears.join("、")} 年日期，与 ${competitionYear} 竞赛年份不一致。`, [...roster.pages, ...certificatePages]);
  }
  const certificateText = certificatePages.map(({ text }) => text).join("\n");
  const readableCertificateYears = fullDateYears(certificateText);
  const wrongCertificateYears = [...new Set(readableCertificateYears.filter((year) => year !== competitionYear))];
  if (wrongCertificateYears.length) {
    return item("training_certificate_coverage", 43, "no", `安全培训证书页检出 ${wrongCertificateYears.join("、")} 年日期，与 ${competitionYear} 竞赛年份不一致。`, [...roster.pages, ...certificatePages]);
  }
  const textualCertificateCount = Math.max(
    (certificateText.match(/Certificate\s+of\s+Completion/giu) ?? []).length,
    (certificateText.match(/AIChE.{0,50}(?:Safety\s+Course|Safety\s+Training\s+Certificate)/giu) ?? []).length,
  );
  const visualCertificateCount = certificatePages.reduce((sum, page) => sum + page.signal.imageCount, 0);
  const certificateCount = Math.max(textualCertificateCount, visualCertificateCount);
  if (certificateCount < roster.dates.length) {
    return item(
      "training_certificate_coverage",
      43,
      "no",
      `培训名单共 ${roster.dates.length} 名成员，但增补文件证书章节仅检出 ${certificateCount} 份证书，请补齐后重新提交。`,
      [...roster.pages, ...certificatePages],
    );
  }
  return item(
    "training_certificate_coverage",
    43,
    "yes",
    `培训名单共 ${roster.dates.length} 名成员，完成日期均为 ${competitionYear} 年；增补文件证书章节检出 ${certificateCount} 份证书，人数与年份检查通过。扫描证书以“名单日期 + 证书图像数量”交叉核验。`,
    [...roster.pages, ...certificatePages],
  );
}

function auditEquipment(documents: readonly EdpReviewDocument[]): CrossDocumentAuditItem {
  const candidatePages = findPages(documents, ["english_edp"], [/\bEquipment\s*List\b/iu]);
  const equipmentPages = candidatePages.filter(({ text }) => /Equipment\s+Manufacturer|Operating\s+Limits|Materials\s+incompatible/iu.test(text));
  if (!equipmentPages.length && candidatePages.length) equipmentPages.push(candidatePages[candidatePages.length - 1]);
  const specificationPages = findPages(documents, ["supplement"], [
    /manufacturer.{0,30}(?:specification|manual|datasheet)/iu,
    /(?:正式|制造商).{0,20}(?:说明书|规格书|数据表)/iu,
    /(?:Appendix|附录)\s*(?:II|Ⅱ|2).{0,40}Equipment\s+Specs?/iu,
    /\bEquipment\s+(?:Specs?|Specifications?)\b/iu,
    /Manufacturer\s*[:：].{0,120}(?:Model|Material|Rated|Operating|Temperature|Pressure)\s*[:：]/iu,
  ]);
  if (!equipmentPages.length) {
    return item("equipment_list_completeness", 15, "no", "英文版未检出 Equipment List。", []);
  }
  const text = equipmentPages.map(({ text: pageText }) => pageText).join("\n");
  if (/\bunknown\b|待填写|未提供|manufacturer\s*[:：]\s*(?:\||$)|(?:temperature|pressure|limit)\s*[:：]\s*(?:\||$)/iu.test(text)) {
    return item("equipment_list_completeness", 15, "no", "Equipment List 存在未知、空白的制造商或适用温度/压力/限制字段，请逐项补全。", equipmentPages);
  }
  const hasManufacturer = /manufacturer|制造商|supplier|供应商/iu.test(text);
  const hasLimits = /temperature|pressure|operating\s+limit|温度|压力|操作限制|ambient/iu.test(text);
  if (!hasManufacturer || !hasLimits) {
    return item("equipment_list_completeness", 15, "no", "Equipment List 未完整给出制造商及适用温度、压力或操作限制。", equipmentPages);
  }
  if (!specificationPages.length) {
    return item("equipment_list_completeness", 15, "no", "设备清单已填写，但增补文件未检出可对应的正式制造商说明书/规格资料。", equipmentPages);
  }
  return item("equipment_list_completeness", 15, "yes", "Equipment List 已包含制造商和适用限制，并在增补文件中检出对应的正式规格资料。", [...equipmentPages, ...specificationPages]);
}

function auditHydrogenCalculation(documents: readonly EdpReviewDocument[]): CrossDocumentAuditItem {
  const pages = findPages(documents, ["english_edp"], [/\bDischarged\s+Hydrogen(?:\s*\(or other flammable chemicals\))?\s+Calculations\b/iu]);
  const text = pages.map(({ text: pageText }) => pageText).join("\n");
  const englishText = combinedText(documents, ["english_edp"]);
  if (/\bno\s+(?:hydrogen|flammable\s+(?:gas|chemical)).{0,40}(?:is\s+)?(?:used|produced|discharged)|does\s+not\s+(?:use|produce|discharge).{0,20}(?:hydrogen|flammable)|no\s+auxiliary\s+processes.{0,120}hydrogen\s+production/isu.test(englishText)) {
    return item("hydrogen_calculation_applicability", 9, "not_applicable", "英文版明确说明不排放氢气或其他可燃物，排放计算按不适用处理。", pages);
  }
  if (!pages.length) {
    return item("hydrogen_calculation_applicability", 9, "needs_human", "未定位到排放氢气/其他可燃物计算页，需结合反应原理人工判断是否适用。", []);
  }
  const calculated = /\d+(?:\.\d+)?\s*(?:g|kg|mol|L|mL|bar|kPa|psig)|(?:→|->|=).{0,80}\d|流量\s*[:：]?\s*\d/iu.test(text);
  return item(
    "hydrogen_calculation_applicability",
    9,
    calculated ? "yes" : "no",
    calculated ? "氢气/其他可燃物排放计算页含计算依据和带单位数值。" : "方案未明确说明不适用，且排放计算页没有可核对的计算依据或带单位结果。",
    pages,
  );
}

function auditPressureCalculation(documents: readonly EdpReviewDocument[]): CrossDocumentAuditItem {
  const pages = findPages(documents, ["english_edp"], [/\bPressure\s+Calculations\b/iu]);
  const text = pages.map(({ text: pageText }) => pageText).join("\n");
  const englishText = combinedText(documents, ["english_edp"]);
  const atmosphericOperation = /Expected\s+Operating\s+Conditions.{0,500}(?:0\s*psig|Pressure\s*[:：]\s*(?:none|N\/?A)|Normal\s+temperature\s+and\s+pressure)|(?:Normal|Minimum|Maximum)\s*[:：]?.{0,100}0\s*psig.{0,80}(?:atmospheric\s+pressure|1\s*atm)|ambient\s+pressure.{0,24}0\s*psig|0\s*psig.{0,24}ambient\s+pressure|无承压|不涉及承压/isu.test(englishText);
  if (atmosphericOperation) {
    return item("pressure_calculation_applicability", 18, "not_applicable", "英文版明确说明所有相关部件在环境压（0 psig）工作，压力计算按不适用处理。", pages);
  }
  if (!pages.length) {
    return item("pressure_calculation_applicability", 18, "needs_human", "未定位到 Pressure Calculations 页，需结合设备和反应系统人工判断是否适用。", []);
  }
  const pressureValues = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(bar|kPa|MPa|psig|psi)/giu)]
    .filter((match) => !((Number(match[1]) === 5 && /psig/i.test(match[2])) || (Number(match[1]) === 0.345 && /bar/i.test(match[2]))));
  const calculated = pressureValues.length > 0 || /(?:MAWP|MOP)\s*[:：=]\s*\d|(?:→|->|=).{0,80}\d/iu.test(text);
  return item(
    "pressure_calculation_applicability",
    18,
    calculated ? "yes" : "no",
    calculated ? "压力计算页含可核对的压力值或计算依据。" : "方案未明确说明压力计算不适用，且页面没有压力值或计算依据。",
    pages,
  );
}

interface GaugePressureFact {
  value: number;
  psig: number;
  unit: string;
  page: LocatedPage;
}

function auditPressureLimits(documents: readonly EdpReviewDocument[], year?: string): CrossDocumentAuditItem[] {
  // Retain existing rule IDs/Excel rows. The supplied 2026 rules, not an old
  // 500-psig template caption, establish the limits (21.1.2, rule PDF p.20).
  const pages = findPages(documents, ["chinese_edp","english_edp"], [/\bMOP\b|最大操作压力|最大允许工作压力|\bMAWP\b/iu])
    .filter(page=>page.document.textQuality === "usable");
  const facts = (page: LocatedPage, label: string): GaugePressureFact[] => {
    const body = normalizeText(page.text).split(/历届比赛作品|近五年|(?:Previous|Past)\s+(?:Five|5)\s+Years/iu)[0];
    const pattern = new RegExp(label+"\\s*(?:[:：=]|is|为|约为)?\\s*(\\d+(?:\\.\\d+)?)\\s*(psig|barg|kPag|MPag)\\b","giu");
    return [...body.matchAll(pattern)].map(match=>{
      const value=Number(match[1]), unit=match[2].toLowerCase();
      const factor=unit==="barg"?14.5037738:unit==="kpag"?0.145037738:unit==="mpag"?145.037738:1;
      return {value,unit,psig:value*factor,page};
    });
  };
  const mops=pages.flatMap(page=>facts(page,"(?:\\bMOP\\b|最大操作压力)"));
  const atmospheric=coreDocuments(documents).some(document=>document.textQuality==="usable" && document.pages.some(text=>
    /无承压(?:系统|部件)|所有.{0,12}(?:部件|系统).{0,20}常压|\ball\s+(?:components|equipment).{0,60}(?:ambient|atmospheric)\s+pressure/iu.test(text)));
  if (atmospheric && mops.every(fact=>fact.psig===0)) return [
    item("max_pressure_500psig",27,"not_applicable","文件明确全部部件为常压/无承压系统，且未检出正的 MOP 表压；承压上限检查不适用。",findPages(documents,["chinese_edp","english_edp"],[/无承压|常压|ambient\s+pressure|atmospheric\s+pressure/iu])),
    item("mawp_gt_mop",20,"not_applicable","常压/无承压系统不要求用压力容器的系统 MAWP/MOP 比例证明；若有任何正表压，应另行提供对应工况。",pages),
  ];
  if (year !== "2026") {
    const candidates=findPages(documents,["chinese_edp","english_edp","supplement"],[/\bMOP\b|最大操作压力/iu]);
    return [
      item("max_pressure_500psig",27,"needs_human","当前年份的压力上限尚未在内置规则中确认，请按已启用的年度规则核对，不能套用旧模板的 500 psig；所列正文/增补资料需区分系统工况与零件额定值。",candidates),
      item("mawp_gt_mop",20,"needs_human","当前年份的系统 MAWP/MOP 比例应按已确认年度规则核对，不能仅凭 MAWP 大于 MOP 自动判定安全。",pages),
    ];
  }
  // Do not use a manufacturer's rating for just one valve as system MAWP.
  const systemMawps=pages.flatMap(page=>facts(page,"(?:\\bSystem\\s+MAWP\\b|系统\\s*MAWP|系统最大允许工作压力)"));
  const exceeded=mops.filter(fact=>fact.unit==="barg"?fact.value>13.8:fact.psig>200);
  const max=item("max_pressure_500psig",27,exceeded.length?"no":mops.length?"yes":"needs_human",
    exceeded.length ? "2026 规则 21.1.2 限制 MOP ≤ 200 psig（13.8 barg），已检出超过该上限的明确表压值；旧 Excel 模板的 500 psig 不能作为本年度通过标准。"
      : mops.length ? "已定位的 MOP 表压值符合 2026 年 200 psig（13.8 barg）上限；设备额定压力、绝压和未说明压力基准的数值不冒充运行 MOP。"
      : "未检出可核对的明确 MOP 表压值，请补充正常最大运行压力及表压/绝压基准；设备额定压力不是实际 MOP。",
    mops.length?mops.map(f=>f.page):pages);
  const pairs=mops.flatMap(mop=>{
    const samePage=(fact: GaugePressureFact)=>fact.page.document===mop.page.document && fact.page.pageIndex===mop.page.pageIndex;
    const onPage=systemMawps.filter(samePage);
    if (new Set(onPage.map(f=>f.psig)).size!==1 || new Set(mops.filter(samePage).map(f=>f.psig)).size!==1) return [];
    return onPage.map(mawp=>({mop,mawp}));
  });
  const uniqueValues=new Set(systemMawps.map(f=>f.psig));
  const nonpositive=pairs.some(({mawp})=>mawp.psig<=0);
  const unsafe=pairs.some(({mop,mawp})=>mop.psig>0.9*mawp.psig+1e-8);
  const fullyPaired=mops.length>0 && mops.every(mop=>pairs.some(pair=>pair.mop===mop)) && uniqueValues.size===1;
  const ratio=item("mawp_gt_mop",20,unsafe||nonpositive?"no":fullyPaired?"yes":"needs_human",
    unsafe||nonpositive ? "2026 规则要求 MOP 不超过系统 MAWP 的 90%；已定位的同页系统参数不满足要求，不能只以 MAWP > MOP 判定通过。"
      : fullyPaired ? "已定位的同页系统参数满足 2026 年 MOP ≤ 90% 系统 MAWP；系统 MAWP 应以指定温度下最弱部件为依据。"
      : "未能可靠配对系统 MOP 与最弱部件决定的系统 MAWP，或存在多组不同系统限值；请核对温度和工况，不能拿单个零件额定值代替系统 MAWP。",
    pairs.length?pairs.flatMap(({mop,mawp})=>[mop.page,mawp.page]):pages);
  return [max,ratio];
}

function auditCapitalCost(documents: readonly EdpReviewDocument[]): CrossDocumentAuditItem {
  const pages = findPages(documents, ["english_edp"], [/\bCapital\s*Cost\s*of\s*Vehicle\s*Calculations\b/iu]);
  if (!pages.length) return item("capital_cost_completeness", 32, "no", "英文版未检出 Capital Cost of Vehicle Calculations。", []);
  const text = pages.map(({ text: pageText }) => normalizeText(pageText)).join(" ");
  const entries = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(?:x|×|\*)\s*(\d+(?:\.\d+)?)\s*=\s*(\d+(?:\.\d+)?)/giu)];
  const totalMatch = /\bTotal\s*[:：]?\s*(\d[\d,]*(?:\.\d+)?)/iu.exec(text);
  const priceText = totalMatch ? text.slice(0, totalMatch.index) : text;
  const yuanPrices = [...priceText.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(?:yuan|元)\b/giu)]
    .map((match) => Number(match[1].replaceAll(",", "")));
  const bilingualTotalMatch = /总计[^\d]{0,24}(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)/u.exec(text);
  if (bilingualTotalMatch && /RMB|人民币/iu.test(text) && /价格\s*\(\s*\$\s*\)|USD|美元/iu.test(text)) {
    const tableStart = text.search(/价格\s*\(\s*\$\s*\)|USD|美元/iu);
    const tableEnd = bilingualTotalMatch.index;
    const tableBody = tableStart >= 0 && tableEnd > tableStart ? text.slice(tableStart, tableEnd) : "";
    const values = [...tableBody.matchAll(/\b\d+(?:\.\d+)?\b/gu)].map((match) => Number(match[0]));
    if (values.length >= 4 && values.length % 2 === 0) {
      const rmbTotal = values.filter((_, index) => index % 2 === 0).reduce((sum, value) => sum + value, 0);
      const usdTotal = values.filter((_, index) => index % 2 === 1).reduce((sum, value) => sum + value, 0);
      const statedRmb = Number(bilingualTotalMatch[1]);
      const statedUsd = Number(bilingualTotalMatch[2]);
      if (Math.abs(rmbTotal - statedRmb) <= 0.02 && Math.abs(usdTotal - statedUsd) <= 0.02) {
        return item("capital_cost_completeness", 32, "yes", "车辆成本表已填写人民币和美元价格及总计，当前可提取的两列加总一致。", pages);
      }
      return item("capital_cost_completeness", 32, "no", "车辆成本表的人民币或美元分项合计与所填总计不一致。", pages);
    }
    return item("capital_cost_completeness", 32, "needs_human", "车辆成本表已填写双币种总计，但 PDF 文本未保留足够稳定的行列结构，算术需人工复核。", pages);
  }
  if (!totalMatch) return item("capital_cost_completeness", 32, "no", "车辆成本表未检出明确合计值。", pages);
  if (yuanPrices.length >= 2) {
    const statedTotal = Number(totalMatch[1].replaceAll(",", ""));
    const calculatedTotal = yuanPrices.reduce((sum, value) => sum + value, 0);
    if (Math.abs(calculatedTotal - statedTotal) <= 0.02) {
      return item("capital_cost_completeness", 32, "yes", "车辆成本表已列出多项人民币价格及总计，当前可提取的分项加总一致。", pages);
    }
    return item("capital_cost_completeness", 32, "no", "车辆成本表的人民币分项价格合计与所填总计不一致。", pages);
  }
  if (!entries.length) return item("capital_cost_completeness", 32, "needs_human", "车辆成本表已填写合计，但 PDF 文本未保留足够的数量×单价结构，算术需人工复核。", pages);
  const rowErrors = entries.filter((entry) => Math.abs(Number(entry[1]) * Number(entry[2]) - Number(entry[3])) > 0.01);
  const calculatedTotal = entries.reduce((sum, entry) => sum + Number(entry[3]), 0);
  const statedTotal = Number(totalMatch[1]);
  if (rowErrors.length || Math.abs(calculatedTotal - statedTotal) > 0.01) {
    return item("capital_cost_completeness", 32, "no", "车辆成本表存在数量×单价或合计的算术不一致。", pages);
  }
  return item("capital_cost_completeness", 32, "yes", "车辆成本表包含条目、数量、单价和合计，当前可提取算术一致。", pages);
}

function capturedValues(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => normalizeText(match[1] ?? "")).filter(Boolean);
}

function auditWasteTags(documents: readonly EdpReviewDocument[]): CrossDocumentAuditItem {
  const wastePages = findPages(documents, ["english_edp"], [
    /Table\s*3\s*[:：]?.{0,520}(?:generate|dispose|Disposal\s+Waste\s+Stream|Waste\s+Description)|Waste\s+Stream\s*[:：]/isu,
  ]);
  const tagPages = findPages(documents, ["english_edp"], [/\bTeam\s+Waste\s+Tags?\b/iu])
    .filter(({ text }) => /Completed\s+Waste\s+Tag\s+Entries|Tag\s*\d+\s*[:：]|No\.\s*[:：]?\s*\d|Waste\s+Description\s*[:：]\s*\S|Composition\s*[:：][\s\S]{0,120}\d/iu.test(text));
  const pages = [...wastePages, ...tagPages];
  const wasteText = wastePages.map(({ text: pageText }) => pageText).join("\n");
  const tagText = tagPages.map(({ text: pageText }) => pageText).join("\n");
  const streams = uniqueNames(capturedValues(wasteText, /Waste\s+Stream\s*[:：]\s*([^|.;；\n]+)/giu));
  const tags = uniqueNames(capturedValues(tagText, /(?:Team\s+Waste\s+)?Tag\s*\d+\s*[:：]\s*([^|.;；\n]+)/giu));
  const amountBasedStreamCount = (wasteText.match(/\b\d+(?:\s*[–—-]\s*\d+)?\s*(?:mL|g)\b(?!\s*\/)/giu) ?? []).length;
  const numberedTagCount = (tagText.match(/\bNo\.\s*[:：]?\s*\d+\b/giu) ?? []).length;
  const wasteMaterials = chemicalIds(wasteText);
  const tagMaterials = chemicalIds(tagText);
  const streamCount = streams.length || amountBasedStreamCount || wasteMaterials.size;
  const tagCount = tags.length || numberedTagCount || tagMaterials.size;
  const uncoveredMaterials = [...wasteMaterials].filter((material) => !tagMaterials.has(material));
  if (!streamCount) return item("waste_tag_consistency", 40, "no", "英文版未检出已填写的 Chemical Waste 废物流。", pages);
  if (!tagCount) return item("waste_tag_consistency", 40, "no", "已填写 Chemical Waste 废物流，但 Team Waste Tags 为空或未检出有效标签。", pages);
  if (wasteMaterials.size > 0 && uncoveredMaterials.length === 0) {
    return item("waste_tag_consistency", 40, "yes", "Chemical Waste 表中的可识别物质均已在 Team Waste Tags 中覆盖；相容物质允许合并在同一张标签中。", pages);
  }
  if (uncoveredMaterials.length > 0) {
    return item("waste_tag_consistency", 40, "no", `Team Waste Tags 未覆盖 Chemical Waste 表中的物质：${chemicalLabels(uncoveredMaterials).join("、")}。`, pages);
  }
  if (streamCount !== tagCount) {
    return item("waste_tag_consistency", 40, "no", `Chemical Waste 表列出 ${streamCount} 类废物流，但检出 ${tagCount} 张有效标签，请做到逐项对应。`, pages);
  }
  if (!streams.length || !tags.length) {
    return item("waste_tag_consistency", 40, "needs_human", `已检出 ${streamCount} 类废物流和 ${tagCount} 张填写过的标签，但 PDF 未保留可可靠比对的名称结构，请人工逐项核对。`, pages);
  }
  const unmatched = streams.filter((stream) => !tags.some((tag) => {
    const streamKey = normalizedKey(stream);
    const tagKey = normalizedKey(tag);
    return streamKey.includes(tagKey) || tagKey.includes(streamKey);
  }));
  if (streams.length !== tags.length || unmatched.length) {
    return item("waste_tag_consistency", 40, "no", `Chemical Waste 表列出 ${streams.length} 类废物流，但检出 ${tags.length} 张有效标签${unmatched.length ? `；未对应：${unmatched.join("、")}` : ""}。`, pages);
  }
  return item("waste_tag_consistency", 40, "yes", "Chemical Waste 表中的废物流与 Team Waste Tags 数量及可提取名称一致。", pages);
}

function auditHazardTypes(documents: readonly EdpReviewDocument[]): CrossDocumentAuditItem {
  const pages = findPages(documents, ["chinese_edp", "english_edp"], [
    /设计过程中隐含的潜在风险|Hazards?\s+inherent\s+in\s+design/iu,
    /\bHazards?\s+Analysis\b|危险分析/iu,
    /Additional\s+Fabrication\s*&\s*Operation\s+Hazard|危险源类型|危险类型/iu,
  ]);
  const text = combinedText(documents, ["chinese_edp", "english_edp"]);
  const categories = [
    /化学|腐蚀|有毒|chemical|corrosi|toxic/iu,
    /压力|承压|pressure/iu,
    /电气|短路|触电|electrical|short\s+circuit|shock/iu,
    /机械|夹伤|切割|碰撞|mechanical|pinch|cutting|impact/iu,
    /温度|高温|低温|热|temperature|thermal|heat|cold/iu,
    /易燃|火灾|爆炸|flammable|fire|explosion/iu,
    /泄漏|溢出|leak|spill/iu,
  ].filter((pattern) => safeTest(pattern, text)).length;
  if (!pages.length || categories < 3) {
    return item("hazard_types", 29, "no", "未能从设计说明、危险分析或操作危险清单中识别至少三类与本方案相关的固有危险源。", pages);
  }
  return item("hazard_types", 29, "yes", `已跨设计说明、危险分析和操作危险清单识别 ${categories} 类固有危险源。`, pages);
}

function auditJsa(documents: readonly EdpReviewDocument[]): CrossDocumentAuditItem {
  const sections = coreDocuments(documents).flatMap(sopSectionPages);
  if (!sections.length) return item("jsa", 30, "no", "未定位到已填写的标准/安全操作（JSA/SOP）章节。", []);
  const text = coreDocuments(documents).map(document => authoredOperatingText(sopSectionPages(document))).join("\n");
  const hasColumns = [
    /步骤顺序|Step\s+Sequence/iu,
    /潜在危险|Potential\s+Hazard/iu,
    /控制\s*风险(?:的\s*步骤)?|Risk\s+Control|Control\s+Method/iu,
    /个人防护\s*用品|防护设备|Personal\s+Protective|PPE/iu,
  ].every((pattern) => safeTest(pattern, text));
  const stagePatterns = [
    /紧急(?:停止|停机)|Emergency\s+(?:Shutdown|Stop)/iu,
    /开始过程|准备过程|开始\s*\/\s*准备|Run\s+Prep(?:aration)?\s+Procedure/iu,
    /起步过程|启动过程|行驶过程|起点过程|Starting\s+Line|Start(?:up)?\s+Procedure/iu,
    /停止过程|Stop(?:ping)?\s+Procedure/iu,
    /行驶距离调整|Distance\s+Adjustment/iu,
    /清洁\s*\/\s*废物处理|Cleanup\s*\/\s*Waste\s+Disposal|Waste\s+Disposal\s+Procedure/iu,
  ];
  const stageMatches = stagePatterns.flatMap(pattern => {
    const match = pattern.exec(text);
    return match ? [{ index:match.index, end:match.index+match[0].length }] : [];
  }).sort((left, right) => left.index - right.index);
  const stages = stageMatches.filter((match, index) => text.slice(match.end, stageMatches[index+1]?.index ?? text.length)
    .replace(/步骤顺序|潜在危险|控制\s*风险的\s*步骤|所需个人防护\s*用品或设备/gu, "")
    .replace(/[\s:：|.。]/gu, "").length >= 4).length;
  if (!hasColumns || stages < 5) {
    return item("jsa", 30, "no", "标准/安全操作章节未同时检出四类安全栏目和至少五个实际填写的关键操作阶段；模板说明或空标题不计为已填写。", sections);
  }
  return item("jsa", 30, "yes", `标准/安全操作章节已检出四类安全栏目及 ${stages} 个实际填写的操作阶段；化学品定量参数在 SOP 专项中另行检查。`, sections);
}

function auditSafeguards(documents: readonly EdpReviewDocument[]): CrossDocumentAuditItem {
  const pages = findPages(documents, ["chinese_edp", "english_edp"], [
    /设计过程中隐含的潜在风险|Hazards?\s+inherent\s+in\s+design/iu,
    /Additional\s+Fabrication\s*&\s*Operation\s+Hazard/iu,
    /标准\s*\/\s*安全操作页|Standard\s*\/\s*Safe\s+Operating/iu,
  ]);
  const text = combinedText(documents, ["chinese_edp", "english_edp"]);
  const controls = [
    /护目镜|goggles?/iu,
    /手套|gloves?/iu,
    /防护口罩|面罩|masks?|face\s+shield/iu,
    /密闭|二次容器|secondary\s+contain|containment|seal(?:ing)?/iu,
    /绝缘|insulat/iu,
    /防护罩|隔板|guard|separator/iu,
    /通风|通风橱|blower|fume\s+hood|ventilat/iu,
    /紧急断电|应急开关|emergency\s+(?:power|switch|shutdown)/iu,
    /分类|标签|label|segregat/iu,
  ].filter((pattern) => safeTest(pattern, text)).length;
  const hazards = /危险|风险|腐蚀|泄漏|短路|hazard|risk|corrosi|leak|short\s+circuit/iu.test(text);
  if (!pages.length || !hazards || controls < 3) {
    return item("safeguards", 31, "no", "未能把已识别危险与至少三类具体工程控制、操作控制或个人防护措施对应起来。", pages);
  }
  return item("safeguards", 31, "yes", `已在风险说明和操作章节中检出 ${controls} 类具体预防、减轻或个人防护措施。`, pages);
}

function auditRisksAndMitigations(documents: readonly EdpReviewDocument[]): CrossDocumentAuditItem {
  const safeguardResult = auditSafeguards(documents);
  return {
    ...safeguardResult,
    ruleId: "risks_and_mitigations",
    suggestedComment: safeguardResult.status === "yes"
      ? "已跨中英文设计说明、危险分析和操作章节识别具体危险，并找到相对应的预防与减轻措施。"
      : "未能把设计中的具体危险与对应的预防、减轻措施可靠配对。",
  };
}

function auditRuleCompliance(documents: readonly EdpReviewDocument[]): CrossDocumentAuditItem {
  const pages = findPages(documents, ["chinese_edp", "english_edp"], [
    /遵(?:守|循)所有安全(?:及|和)竞赛规则|followed\s+all\s+of\s+the\s+safety\s+and\s+competition\s+rules/iu,
    /相比(?:于)?去年|Compared\s+with\s+last\s+year|reaction\s+chemistry.{0,80}changed/iu,
  ]);
  const text = combinedText(documents, ["chinese_edp", "english_edp"]);
  const operationalPages = coreDocuments(documents).flatMap(sopSectionPages);
  const controlDescriptions = coreDocuments(documents).map(document => extractLabeledSection(document.pages.slice(0, 5).join("\n"),
    /(?:控制机制|制动机制|停止机制|(?:control|stopping|braking)\s+mechanism)\s*[:：]/iu,
    [/辅助过程|auxiliary\s+process|(?:设计过程中隐含的)?潜在风险|inherent\s+hazard|创新点|innovation/iu]));
  const sopBodies = coreDocuments(documents).map(document => authoredOperatingText(sopSectionPages(document)));
  const normalStopDescriptions = sopBodies.map(body => extractLabeledSection(body,
    /(?:停止过程|停车过程|Stopping\s+Procedure)\s*[:：]?/iu,
    [/行驶距离调整|距离调整|Distance\s+Adjustment|清洁|Cleanup|Waste\s+Disposal/iu]));
  const manualNormalStop = [...controlDescriptions, ...normalStopDescriptions].some(description => description.split(/[。；;\n]/u).some(clause =>
    /(?:观察到|观察|显色|变色|colour|color).{0,65}(?:手动|人工|队员|operator|manually).{0,28}(?:切断|断开|关闭|disconnect|cut|turn\s+off).{0,24}(?:电机|电源|motor|power)/iu.test(clause)));
  const manualSwitchObservation = controlDescriptions.some(description => /手动断电开关|人工停车开关/iu.test(description)
    && /观察.{0,30}(?:显色|变色).{0,30}按下.{0,12}开关/iu.test(description));
  if (manualNormalStop || manualSwitchObservation) return item("rule_violations", 32, "no", "正常停车依赖人员观察化学变色后手动切断动力，不满足车辆自主停车要求；紧急事故时的人工断电不属于这一判定。", [...findPages(documents, ["chinese_edp", "english_edp"], [/制动机制|控制机制|停止过程|Stopping\s+Procedure/iu]), ...operationalPages]);
  const startingDescriptions = sopBodies.map(body => extractLabeledSection(body,
    /(?:起步过程|起点过程|启动过程|行驶过程|Starting\s+Line(?:\s+Procedure)?|Startup\s+Procedure)\s*[:：]?/iu,
    [/停止过程|停车过程|Stopping\s+Procedure|Distance\s+Adjustment|行驶距离调整|清洁|Cleanup/iu]));
  const actualAlligatorConnection = currentChemicalText(documents).split(/[。；;，,\n]/u).some(clause =>
    !/(?:不使用|不用|未使用|禁止使用|不得使用|已移除|已更换|改用).{0,8}鳄鱼夹|(?:without|not\s+us(?:e|ing)|no|removed|replaced|prohibited)\s+(?:alligator|crocodile)\s+clips/iu.test(clause)
    && /(?:使用|采用|用|通过).{0,16}(?:鳄鱼夹)|(?:connect|using|use).{0,36}(?:alligator|crocodile)\s+clips/iu.test(clause));
  if (actualAlligatorConnection) return item("rule_violations", 32, "no", "当前接线步骤明确使用鳄鱼夹，违反电气连接安全要求；应采用接线柱等可靠连接方式。历史方案、模板问题和已移除/不使用的说明不属于本项违规证据。", findPages(documents, ["chinese_edp","english_edp"], [/鳄鱼夹|(?:alligator|crocodile)\s+clips/iu]));
  const manualStartDosing = startingDescriptions.some(description => description.split(/[。；;，,\n]/u).some(clause => {
    if (/(?:禁止|不得|不允许|不能|不)(?:使用|进行)?(?:手动|人工)?(?:注入|加液|倾倒|倒入|滴加|量取|移取|移液)|(?:do\s+not|must\s+not|never)\s+(?:manually\s+)?(?:pour|pipett|inject)|no\s+manual\s+(?:pour|pipett|inject)/iu.test(clause)) return false;
    const manual = /手动|人工|manually|manual\s+(?:pour|pipett)|注射器|syringe/iu.test(clause);
    const dosing = /注入|加液|倾倒|倒入|滴加|量取|移取|\bpour|pipett|\binject/iu.test(clause);
    return manual && dosing;
  }));
  if (manualStartDosing) return item("rule_violations", 32, "no", "起跑线/启动阶段明确包含手动注液、倾倒或移液，应在准备台完成装填并固定密闭后再进入起跑线；打开预装车载阀门或开关不等同于手动加液。", operationalPages);
  const explicitViolation = /(?:存在|发现|确认).{0,16}(?:违规|违反规则)|(?:violat(?:ion|ed)|noncompliance).{0,24}(?:found|confirmed|present)/iu.test(text);
  if (explicitViolation) return item("rule_violations", 32, "no", "EDP 文字中出现明确的规则不符合或违规说明。", pages);
  const certified = /遵(?:守|循)所有安全(?:及|和)竞赛规则|严格遵守所有安全及竞赛规则|followed\s+all\s+of\s+the\s+safety\s+and\s+competition\s+rules/iu.test(text);
  const reactionChanged = /相比(?:于)?去年[\s\S]{0,260}(?:采用|更换|改变|改进|优化|镁|新)|Compared\s+with\s+last\s+year[\s\S]{0,320}(?:changed|uses?|magnesium|improv|optimiz)|reaction\s+chemistry[\s\S]{0,100}(?:changed|different)/iu.test(text);
  const firstEntry = /首次参赛|未曾参加过\s*Chem-E-Car|did\s+not\s+compete.{0,80}previous/iu.test(text);
  if (certified && (reactionChanged || firstEntry)) {
    return item("rule_violations", 32, "yes", "安全认证声明已确认遵守竞赛规则，且已说明相较上一年度的反应/系统变化（首次参赛时允许无历史方案）；未检出明确违规证据。", pages);
  }
  return item("rule_violations", 32, "needs_human", "未检出明确违规文字，但安全规则声明或与上一年度方案变化的证据不足，不能仅凭“未检出”自动判定符合。", pages);
}

function auditMoc(documents: readonly EdpReviewDocument[], round: CrossDocumentAuditContext["submissionRound"]): CrossDocumentAuditItem {
  if (round === 1) return item("moc", 34, "not_applicable", "第1次 EDP 提交不要求 MOC。", []);
  const document = documents.find(({ role }) => role === "moc");
  if (!document) return item("moc", 34, "no", `第${round}次提交缺少 MOC 文件。`, []);
  const pages = document.pages.map((text, pageIndex) => ({
    document,
    pageIndex,
    text,
    signal: document.pageSignals?.[pageIndex] ?? EMPTY_SIGNAL,
  }));
  if (document.textQuality !== "usable") return item("moc", 34, "needs_human", "MOC 正文无法可靠读取，不能把扫描图像或提取失败当作空文件；请对照原 PDF 核对。", pages);
  // A repeated version footer must never fill an empty reason/approval field.
  const text = pages.map(({ text: pageText }) => pageText.replace(/\bVersion\s*\d+(?:\.\d+)+\b/giu,"")).join("\n");
  const summaryLabel = /(?:(?:Summary\s*)?Description\s*of\s*Change(?!\s*as\s*Approved)|Change\s*summary|变更(?:内容|描述|摘要))\s*[:：]?/iu;
  const reasonLabel = /(?:Reasons?(?:\s*\(s\))?\s*for\s*Change|变更(?:原因|理由))\s*[:：]?/iu;
  const approvalLabel = /(?:Description\s*of\s*Change\s*as\s*Approved|Description\s*of\s*Approved\s*Changes|批准(?:的)?变更(?:内容|描述))\s*[:：]?/iu;
  const requestSignatureLabel = /(?:Signature\s*of\s*Request(?:or|er)|Request(?:or|er)['’]?s?\s*Signature|申请人签名)\s*[:：]?/iu;
  const approvalSignatureLabel = /Signatures?\s*of\s*Approval|Approval\s*signature|Faculty\s*Advis[oe]r\s*[:：]|Review\s*Team\s*Member\s*[:：]|批准签名|指导教师签名/iu;
  const requestSignaturePages = pages.filter(page => safeTest(requestSignatureLabel, page.text));
  const approvalStart = pages.findIndex(page => safeTest(approvalLabel,page.text) || /PROCESS\s*CHANGE\s*REQUEST\s*APPROVAL\s*FORM|变更批准/iu.test(page.text));
  const approvalSignaturePages = pages.filter(page => page.pageIndex >= approvalStart && approvalStart >= 0 && safeTest(approvalSignatureLabel, page.text));
  const requestPage = pages.find(({ text: pageText }) => /MANAGEMENT\s+OF\s+CHANGE\s+REQUEST\s+FORM|Name\s+of\s+Person\s+or\s+Group\s+Requesting\s+Change|Summary\s+Description\s+of\s+Change|变更申请/iu.test(pageText));
  const approvalPage = approvalStart >= 0 ? pages[approvalStart] : undefined;
  const checklistPage = pages.find(({ text: pageText }) => /SAFETY\s+EVALUATION\s+CHECKLIST|安全评估清单/iu.test(pageText));
  const description = extractLabeledSection(text, summaryLabel, [reasonLabel, /Changes?\s*(?:is|are)\s*[:：]|变更类型/iu, requestSignatureLabel, approvalLabel]);
  const reason = extractLabeledSection(text, reasonLabel, [/Changes?\s*(?:is|are)\s*[:：]|变更类型/iu, requestSignatureLabel, /PROCESS\s*CHANGE\s*REQUEST/iu, approvalLabel]);
  const approvedDescription = extractLabeledSection(text, approvalLabel, [/Approved\s*Duration\s*of\s*Change|Approval\s*period\s*for\s*change|批准(?:期限|期间)/iu, approvalSignatureLabel]);
  if (normalizeText(text).length < 100 || !hasMeaningfulMocEntry(description)) {
    return item("moc", 34, "no", "MOC 内容为空或未填写具体的变更内容。", pages);
  }
  if (!hasMeaningfulMocEntry(reason)) {
    return item("moc", 34, "no", "MOC 未填写具体的改变理由（Reason for Change），请补充后重新提交。", pages);
  }
  const replacementReagents = (entry: string): string[] => {
    const target = /(?:\b(?:electrolyte|acid)\b[^.;]{0,40}(?:changed\s*to|replaced\s*(?:by|with)|switched\s*to)|电解液.{0,12}(?:改为|更换为|替换为))\s*([^;；。]{1,140})/iu.exec(entry)?.[1] ?? "";
    const identities: [RegExp,string][] = [
      [/citric\s*acid|柠檬酸/iu,"柠檬酸"],
      [/acetic\s*acid|乙酸|醋酸/iu,"乙酸"],
      [/potassium\s*hydroxide|\bKOH\b|氢氧化钾/iu,"氢氧化钾"],
      [/sodium\s*hydroxide|\bNaOH\b|氢氧化钠/iu,"氢氧化钠"],
    ];
    return identities.filter(([pattern])=>pattern.test(target)).map(([,name])=>name);
  };
  const proposedReagents = replacementReagents(description);
  const approvedReagents = replacementReagents(approvedDescription);
  if (proposedReagents.length && approvedReagents.length && !proposedReagents.some(name=>approvedReagents.includes(name))) {
    return item("moc",34,"needs_human","MOC 申请内容与批准内容中的替换电解液/酸不一致：申请为 "+proposedReagents.join("、")+"，批准为 "+approvedReagents.join("、")+"。请与当前 EDP 配方逐项核对，不能自动认定整改已落实。",pages);
  }
  const requestorFieldBlank = /Requestor\s+Signature\s*[:：]?\s*(?=\||Date\s*[:：]?|$)|申请人签名\s*[:：]?\s*(?=\||日期\s*[:：]?|$)/imu.test(text);
  const explicitlyBlank = /(?:requestor|approval).{0,50}signature\s+lines?\s+are\s+(?:intentionally\s+)?left\s+blank/imu.test(text);
  const requestorSigned = /(?:Requestor\s+Signature|申请人签名).{0,24}\[(?:signed|已签)\]|(?:申请人|Requestor).{0,20}(?:已签名|已签字)/iu.test(text);
  const facultySigned = /(?:Faculty\s+Advisor\s+Signature|指导教师签名).{0,24}\[(?:signed|已签)\]|(?:指导教师|Faculty\s+Advisor).{0,20}(?:已签名|已签字)/iu.test(text);
  const reviewSigned = /(?:Review(?:er)?\s+Signature|审核(?:人|员)?签名).{0,24}\[(?:signed|已签)\]|(?:审核人|Reviewer).{0,20}(?:已签名|已签字)/iu.test(text);
  const requestSignatureVisual = requestSignaturePages.some(page => page.signal.imageCount > 0 || page.signal.annotationCount > 0);
  const approvalSignatureVisual = approvalSignaturePages.some(page => page.signal.imageCount > 0 || page.signal.annotationCount > 0);
  if (explicitlyBlank || (requestorFieldBlank && requestPage && !requestSignatureVisual)
    || (!requestorSigned && requestSignaturePages.length > 0 && !requestSignatureVisual)) {
    return item("moc", 34, "no", "MOC 的申请人（Requestor）签名为空，请由申请人补签。", pages);
  }
  if (!hasMeaningfulMocEntry(approvedDescription)) {
    if (!safeTest(approvalLabel,text)) return item("moc",34,"needs_human","MOC 已填写申请内容和理由，但未可靠定位批准内容字段；请核对非标准版式中的审批记录，不能把未识别直接当作空文件或已经批准。",pages);
    return item("moc", 34, "no", "MOC 批准页未填写实际批准的变更内容（Approval Description）；可引用已经具体填写的申请内容，但不能只留模板空栏。", pages);
  }
  const applicant = extractLabeledSection(text, /Name\s*of\s*(?:Person\s*or\s*Group\s*Requesting\s*Change|the\s*individual\s*or\s*group\s*applying\s*for\s*change)\s*[:：]|变更申请人\s*[:：]/iu, [/Date\s*[:：]|日期\s*[:：]/iu]);
  const requestorNamed = /[\p{L}\p{Script=Han}]{2,}/u.test(applicant);
  const requestDatePresent = requestPage ? fullDateYears(requestPage.text).length >= 1 : false;
  const approvalDatePresent = approvalSignaturePages.some(page => fullDateYears(page.text).length >= 1);
  if (requestorNamed && requestSignatureVisual && approvalSignatureVisual
    && requestDatePresent && approvalDatePresent && checklistPage) {
    return item("moc", 34, "yes", "MOC 已填写具体变更内容和改变理由；申请人及至少一名主要审核人员已在对应位置签名并填写日期。安全评估清单中未涉及本次改动的栏目允许留空。", pages);
  }
  if (!approvalPage || (!approvalSignatureVisual && !facultySigned && !reviewSigned)) {
    return item("moc", 34, "no", "MOC 批准页缺少主要审核人员签名；只需申请人及至少一名主要审核/指导人员签署，不要求全体人员签名。", pages);
  }
  if (requestorSigned && (facultySigned || reviewSigned)) {
    return item("moc", 34, "needs_human", "MOC 已填写变更内容和理由，并检测到申请人及主要审核人员的已签署文字标记；请人工确认手写签名及日期。未涉及本次改动的栏目允许留空。", pages);
  }
  return item("moc", 34, "needs_human", `MOC 已填写变更内容和理由，但主要签署证据或日期尚未同时达到自动判定条件（申请人 ${requestorNamed ? "已填" : "未识别"}、申请人签名 ${requestSignatureVisual ? "已检出" : "未确认"}、主要审核签名 ${approvalSignatureVisual ? "已检出" : "未确认"}、申请日期 ${requestDatePresent ? "已填" : "未识别"}、批准日期 ${approvalDatePresent ? "已填" : "未识别"}、安全评估清单 ${checklistPage ? "已检出" : "未识别"}），请人工核对；不要求全体人员签名，也不要求填写与本次改动无关的栏目。`, pages);
}

export function auditCrossDocumentEdp(
  documents: readonly EdpReviewDocument[],
  context: CrossDocumentAuditContext,
): CrossDocumentAuditItem[] {
  const results = [
    auditHazardTypes(documents),
    auditJsa(documents),
    auditSafeguards(documents),
    auditRisksAndMitigations(documents),
    auditRuleCompliance(documents),
    auditChemicalInventoryAndSds(documents),
    auditPpe(documents),
    auditCertificationSignatures(documents),
    auditMoc(documents, context.submissionRound),
    auditHazardsAnalysis(documents),
    auditLaboratoryFloorPlan(documents),
    auditPrimaryHazardsChecklist(documents),
    auditTrainingCertificates(documents, context.competitionYear),
    auditEquipment(documents),
    auditHydrogenCalculation(documents),
    auditPressureCalculation(documents),
    ...auditPressureLimits(documents, context.competitionYear),
    auditCapitalCost(documents),
    auditWasteTags(documents),
  ];
  // Memory-limited image extraction cannot establish that a signature or plan
  // is absent. Keep explicit textual failures (wrong year, blank reason, etc.).
  return results.map(result => {
    if (result.status !== "no" || !/签名|平面图|Floor Plan/iu.test(result.suggestedComment)) return result;
    const roles: EdpDocumentRole[] = result.ruleId === "moc" ? ["moc"] : ["chinese_edp", "english_edp"];
    const limitedPages = documents.filter(doc => roles.includes(doc.role)).flatMap(document =>
      document.pages.flatMap((text, pageIndex) => {
        const signal = document.pageSignals?.[pageIndex];
        const selected = result.evidence.length === 0 || result.evidence.some(e => e.filename === document.filename && e.page === pageIndex + 1);
        return signal?.visualReadLimited && selected ? [{document, pageIndex, text, signal}] : [];
      }));
    if (!limitedPages.length) return result;
    return item(result.ruleId, result.row, "needs_human", "已定位相关页面，但图像核验受到内存上限限制，不能据此判定签名或平面图缺失；请查看所列原 PDF 页。", limitedPages);
  });
}
