export type EdpReviewStatus = "yes" | "no" | "not_applicable" | "needs_human";

export type EdpDocumentRole = "chinese_edp" | "english_edp" | "supplement" | "moc";

export interface EdpPageVisualSignal {
  imageCount: number;
  // Bounded server decoding may omit large raster objects; absence is not proof.
  visualReadLimited?: boolean;
  annotationCount: number;
  pathPaintCount: number;
}

export interface EdpReviewDocument {
  role: EdpDocumentRole;
  filename: string;
  pages: string[];
  pageSignals?: EdpPageVisualSignal[];
  textQuality: "usable" | "low" | "empty";
}

export interface EdpReviewEvidence {
  documentRole: EdpDocumentRole;
  filename: string;
  page: number;
  excerpt: string;
}

export interface EdpReviewRule {
  id: keyof typeof EDP_REVIEW_RULE_ROWS;
  row: number;
  label: string;
  documentRoles: readonly EdpDocumentRole[];
  positivePatterns: readonly RegExp[];
  negativePatterns: readonly RegExp[];
  notApplicablePatterns: readonly RegExp[];
  autoResolve: boolean;
  isBlocking: boolean;
  ruleSource: string;
}

export interface EdpReviewRuleResult {
  ruleId: EdpReviewRule["id"];
  row: number;
  status: EdpReviewStatus;
  isBlocking: boolean;
  ruleSource: string;
  evidence: EdpReviewEvidence[];
  suggestedComment: string;
}

export const EDP_REVIEW_RULE_VERSION = "v1";

export const EDP_REVIEW_RULE_ROWS = Object.freeze({
  chemical_sds: 5,
  ppe: 6,
  reactions_overview: 8,
  onsite_hydrogen: 9,
  operating_principle: 10,
  vehicle_photo: 11,
  syringes_fixed: 12,
  secondary_containment: 13,
  component_specs: 15,
  commercial_component_docs: 16,
  pressure_vessel_certificate: 18,
  no_plastic_pressure: 19,
  mawp_gt_mop: 20,
  plastic_pressure_test_docs: 21,
  pressure_relief_device: 22,
  unknown_mawp_external_cert: 23,
  instructor_signed_relief_basis: 24,
  relief_sizing: 25,
  relief_test: 26,
  max_pressure_500psig: 27,
  hazard_types: 29,
  jsa: 30,
  safeguards: 31,
  rule_violations: 32,
  moc: 34,
  aisle: 36,
  emergency_equipment: 37,
  sop: 39,
  chemical_waste_sop: 40,
  post_competition_cleanup: 41,
  certification_signatures: 43,
  ten_hours_experience: 44,
} as const);

const ALL_EDP_DOCUMENTS = ["chinese_edp", "english_edp", "supplement", "moc"] as const;
const CORE_EDP_DOCUMENTS = ["chinese_edp", "english_edp"] as const;
const SUPPLEMENT_DOCUMENTS = ["supplement", "moc"] as const;

type RuleInput = Omit<EdpReviewRule, "id" | "row" | "isBlocking" | "ruleSource">
  & Partial<Pick<EdpReviewRule, "isBlocking" | "ruleSource">>;

function defineRule(id: EdpReviewRule["id"], input: RuleInput): EdpReviewRule {
  return Object.freeze({
    id,
    row: EDP_REVIEW_RULE_ROWS[id],
    isBlocking: true,
    ruleSource: `builtin:${EDP_REVIEW_RULE_VERSION}`,
    ...input,
  });
}

export const EDP_REVIEW_RULES: readonly EdpReviewRule[] = Object.freeze([
  defineRule("chemical_sds", {
    label: "反应物及产物安全数据表与含铅电池",
    documentRoles: ALL_EDP_DOCUMENTS,
    positivePatterns: [
      /(?:全部|所有|每种|所涉及).{0,24}(?:反应物|化学品).{0,30}(?:产物|生成物).{0,30}(?:安全数据表|SDS|MSDS)/iu,
      /(?:安全数据表|SDS|MSDS).{0,80}(?:不使用|未使用|不含|禁止使用).{0,12}含铅电池/iu,
    ],
    negativePatterns: [/(?:缺少|未提供|未附).{0,20}(?:安全数据表|SDS|MSDS)|(?<![不未])(?:使用|采用).{0,12}含铅电池/iu],
    notApplicablePatterns: [],
    autoResolve: true,
  }),
  defineRule("ppe", {
    label: "个人防护装备",
    documentRoles: CORE_EDP_DOCUMENTS,
    positivePatterns: [/(?:个人防护装备|PPE).{0,80}(?:护目镜|面罩|手套|实验服|防护服)/iu],
    negativePatterns: [/(?:不佩戴|无需|未提供).{0,20}(?:个人防护装备|PPE|护目镜|手套)/iu],
    notApplicablePatterns: [],
    autoResolve: false,
  }),
  defineRule("reactions_overview", {
    label: "全部反应概述",
    documentRoles: CORE_EDP_DOCUMENTS,
    positivePatterns: [/(?:所有|全部).{0,20}(?:反应|reaction).{0,40}(?:说明|方程式|机理|概述|描述)/iu],
    negativePatterns: [/(?:反应|reaction).{0,30}(?:未说明|缺少|未提供)/iu],
    notApplicablePatterns: [],
    autoResolve: false,
  }),
  defineRule("onsite_hydrogen", {
    label: "现场制氢压力低于 0.345 bar",
    documentRoles: CORE_EDP_DOCUMENTS,
    positivePatterns: [/(?:现场|原位).{0,16}(?:制氢|生成氢气).{0,30}(?:低于|小于|不超过|≤|<=)\s*0[.．]345\s*bar/iu],
    negativePatterns: [/(?:现场|原位).{0,16}(?:制氢|生成氢气).{0,30}(?:高于|大于|超过|>)\s*0[.．]345\s*bar/iu],
    notApplicablePatterns: [/(?:不涉及|未采用|没有|无).{0,16}(?:现场|原位)?制氢|(?:现场|原位)?制氢.{0,12}(?:不适用|N\/?A)/iu],
    autoResolve: true,
  }),
  defineRule("operating_principle", {
    label: "车辆工作原理",
    documentRoles: CORE_EDP_DOCUMENTS,
    positivePatterns: [/(?:车辆|小车).{0,16}(?:工作原理|运行原理|驱动原理|operating principle)/iu],
    negativePatterns: [/(?:工作原理|运行原理|operating principle).{0,20}(?:缺少|未填写|未提供)/iu],
    notApplicablePatterns: [],
    autoResolve: false,
  }),
  defineRule("vehicle_photo", {
    label: "完整车辆照片",
    documentRoles: CORE_EDP_DOCUMENTS,
    positivePatterns: [/(?:完整|整车).{0,12}(?:车辆|小车).{0,12}(?:照片|图片|photo)/iu],
    negativePatterns: [/(?:车辆|小车).{0,12}(?:照片|图片|photo).{0,16}(?:缺少|未提供|未附)/iu],
    notApplicablePatterns: [],
    autoResolve: false,
    isBlocking: false,
  }),
  defineRule("syringes_fixed", {
    label: "注射器固定且不可拆卸",
    documentRoles: CORE_EDP_DOCUMENTS,
    positivePatterns: [/(?:注射器|syringe).{0,30}(?:牢固固定|紧固|不可拆卸|无法拆卸)/iu],
    negativePatterns: [/(?:注射器|syringe).{0,30}(?:松动|可拆卸|未固定)/iu],
    notApplicablePatterns: [/(?:不使用|未使用|没有|无).{0,12}(?:注射器|syringe)/iu],
    autoResolve: false,
  }),
  defineRule("secondary_containment", {
    label: "二次容纳空间足够",
    documentRoles: CORE_EDP_DOCUMENTS,
    positivePatterns: [/(?:二次容纳|二次围堵|secondary containment).{0,50}(?:容积|容量).{0,24}(?:足够|大于|不小于|≥|>=)/iu],
    negativePatterns: [/(?:二次容纳|二次围堵|secondary containment).{0,50}(?:不足|小于|未设置)/iu],
    notApplicablePatterns: [],
    autoResolve: false,
  }),
  defineRule("component_specs", {
    label: "零部件、温度与压力参数",
    documentRoles: ALL_EDP_DOCUMENTS,
    positivePatterns: [/(?:全部|所有).{0,16}(?:部件|零件|组件|component).{0,40}(?:温度|temperature).{0,24}(?:压力|pressure)/iu],
    negativePatterns: [/(?:部件|零件|组件).{0,24}(?:参数|温度|压力).{0,20}(?:缺少|未提供)/iu],
    notApplicablePatterns: [],
    autoResolve: false,
  }),
  defineRule("commercial_component_docs", {
    label: "商用部件制造商资料",
    documentRoles: SUPPLEMENT_DOCUMENTS,
    positivePatterns: [/(?:商用|商业).{0,16}(?:部件|组件).{0,30}(?:制造商|供应商).{0,24}(?:规格|说明书|数据表|文件)/iu],
    negativePatterns: [/(?:制造商|供应商).{0,24}(?:规格|说明书|数据表|文件).{0,20}(?:缺少|未提供)/iu],
    notApplicablePatterns: [/(?:不使用|未使用|没有|无).{0,20}(?:商用|商业).{0,12}(?:部件|组件)/iu],
    autoResolve: false,
  }),
  defineRule("pressure_vessel_certificate", {
    label: "压力容器认证或水压试验",
    documentRoles: SUPPLEMENT_DOCUMENTS,
    positivePatterns: [/(?:压力容器|pressure vessel).{0,40}(?:认证|合格证|水压试验|hydrostatic test)/iu],
    negativePatterns: [/(?:压力容器|pressure vessel).{0,40}(?:未认证|无认证|缺少.{0,8}(?:证书|水压试验))/iu],
    notApplicablePatterns: [/(?:不使用|未使用|没有|无).{0,16}(?:压力容器|pressure vessel)/iu],
    autoResolve: false,
  }),
  defineRule("no_plastic_pressure", {
    label: "承压系统不使用塑料或 PVC",
    documentRoles: ALL_EDP_DOCUMENTS,
    positivePatterns: [/(?:承压|压力).{0,20}(?:系统|管路).{0,30}(?:不使用|未使用|不含).{0,16}(?:塑料|PVC)/iu],
    negativePatterns: [/(?:承压|压力).{0,20}(?:系统|管路).{0,30}(?:使用|采用).{0,16}(?:塑料|PVC)/iu],
    notApplicablePatterns: [/(?:无|没有|不涉及).{0,12}(?:承压|压力)(?:系统|部件|管路)/iu],
    autoResolve: true,
  }),
  defineRule("mawp_gt_mop", {
    label: "MAWP 高于 MOP",
    documentRoles: ALL_EDP_DOCUMENTS,
    positivePatterns: [/(?:MAWP|最大允许工作压力).{0,20}(?:>|＞|高于|大于).{0,20}(?:MOP|最大操作压力)/iu],
    negativePatterns: [/(?:MAWP|最大允许工作压力).{0,20}(?:≤|<=|不高于|小于|低于).{0,20}(?:MOP|最大操作压力)/iu],
    notApplicablePatterns: [/(?:无|没有|不涉及).{0,12}(?:承压|压力)(?:系统|部件|管路)/iu],
    autoResolve: true,
  }),
  defineRule("plastic_pressure_test_docs", {
    label: "塑料管制造商压力试验资料",
    documentRoles: SUPPLEMENT_DOCUMENTS,
    positivePatterns: [/(?:塑料管|PVC管|plastic tubing).{0,50}(?:制造商|厂家).{0,30}(?:压力试验|耐压试验).{0,20}(?:报告|资料|文件|数据)/iu],
    negativePatterns: [/(?:塑料管|PVC管|plastic tubing).{0,50}(?:压力试验|耐压试验).{0,20}(?:缺少|未提供)/iu],
    notApplicablePatterns: [/(?:不使用|未使用|没有|无).{0,16}(?:塑料管|PVC管|plastic tubing)/iu],
    autoResolve: false,
  }),
  defineRule("pressure_relief_device", {
    label: "适当的压力释放装置",
    documentRoles: ALL_EDP_DOCUMENTS,
    positivePatterns: [/(?:安装|设置|配备|采用).{0,20}(?:压力释放装置|泄压装置|安全阀|爆破片|pressure relief)/iu],
    negativePatterns: [/(?:未安装|未设置|未配备|缺少).{0,20}(?:压力释放装置|泄压装置|安全阀|爆破片|pressure relief)/iu],
    notApplicablePatterns: [/(?:无|没有|不涉及).{0,12}(?:承压|压力)系统|(?:压力释放装置|泄压装置|安全阀).{0,16}(?:不适用|N\/?A)/iu],
    autoResolve: true,
  }),
  defineRule("unknown_mawp_external_cert", {
    label: "未知 MAWP 的外部商业认证",
    documentRoles: SUPPLEMENT_DOCUMENTS,
    positivePatterns: [/(?:MAWP|最大允许工作压力).{0,20}(?:未知|无法确定).{0,50}(?:外部|第三方|商业).{0,20}(?:认证|证明|证书)/iu],
    negativePatterns: [/(?:MAWP|最大允许工作压力).{0,20}(?:未知|无法确定).{0,50}(?:无|没有|缺少|未提供).{0,20}(?:认证|证明|证书)/iu],
    notApplicablePatterns: [/(?:MAWP|最大允许工作压力).{0,20}(?:已知|明确|可确定)/iu],
    autoResolve: false,
  }),
  defineRule("instructor_signed_relief_basis", {
    label: "指导教师签署泄压计算依据",
    documentRoles: SUPPLEMENT_DOCUMENTS,
    positivePatterns: [/(?:指导教师|instructor).{0,30}(?:签字|签署|签名|signed).{0,50}(?:泄压|压力释放).{0,20}(?:计算|依据|基础)/iu],
    negativePatterns: [/(?:泄压|压力释放).{0,20}(?:计算|依据|基础).{0,30}(?:未签字|缺少签字|未签署)/iu],
    notApplicablePatterns: [/(?:无|没有|不涉及).{0,12}(?:承压|压力)系统/iu],
    autoResolve: false,
  }),
  defineRule("relief_sizing", {
    label: "泄压装置选型与负荷计算",
    documentRoles: SUPPLEMENT_DOCUMENTS,
    positivePatterns: [/(?:泄压|压力释放).{0,20}(?:装置|阀).{0,40}(?:选型|尺寸|口径|负荷|sizing|load).{0,20}(?:计算|依据)/iu],
    negativePatterns: [/(?:泄压|压力释放).{0,20}(?:选型|尺寸|口径|负荷).{0,20}(?:缺少|未提供|未计算)/iu],
    notApplicablePatterns: [/(?:无|没有|不涉及).{0,12}(?:承压|压力)系统/iu],
    autoResolve: false,
  }),
  defineRule("relief_test", {
    label: "泄压装置试验与结果",
    documentRoles: SUPPLEMENT_DOCUMENTS,
    positivePatterns: [/(?:泄压|压力释放).{0,20}(?:装置|阀).{0,30}(?:试验|测试|test).{0,20}(?:结果|报告|记录)/iu],
    negativePatterns: [/(?:泄压|压力释放).{0,20}(?:试验|测试|test).{0,20}(?:缺少|未提供|未进行)/iu],
    notApplicablePatterns: [/(?:无|没有|不涉及).{0,12}(?:承压|压力)系统/iu],
    autoResolve: false,
  }),
  defineRule("max_pressure_500psig", {
    label: "最大操作压力不超过 500 psig",
    documentRoles: ALL_EDP_DOCUMENTS,
    positivePatterns: [/(?:最大操作压力|MOP).{0,36}(?:≤|<=|不高于|不大于|不超过|低于|小于).{0,12}500\s*(?:psig|psi)/iu],
    negativePatterns: [/(?:最大操作压力|MOP).{0,36}(?:>|＞|高于|大于|超过).{0,12}500\s*(?:psig|psi)/iu],
    notApplicablePatterns: [/(?:无|没有|不涉及).{0,12}(?:承压|压力)系统/iu],
    autoResolve: true,
  }),
  defineRule("hazard_types", {
    label: "危险类型识别",
    documentRoles: CORE_EDP_DOCUMENTS,
    positivePatterns: [/(?:危险类型|危险识别|hazard identification).{0,80}(?:化学|压力|机械|热|电气|生物)/iu],
    negativePatterns: [/(?:危险类型|危险识别|hazard identification).{0,20}(?:缺少|未填写|未提供)/iu],
    notApplicablePatterns: [],
    autoResolve: false,
  }),
  defineRule("jsa", {
    label: "作业安全分析（JSA）",
    documentRoles: CORE_EDP_DOCUMENTS,
    positivePatterns: [/(?:作业安全分析|工作安全分析|JSA|job safety analysis).{0,60}(?:危害|风险|控制措施|防护措施)/iu],
    negativePatterns: [/(?:作业安全分析|工作安全分析|JSA).{0,20}(?:缺少|未填写|未提供)/iu],
    notApplicablePatterns: [],
    autoResolve: true,
  }),
  defineRule("safeguards", {
    label: "安全防护措施",
    documentRoles: CORE_EDP_DOCUMENTS,
    positivePatterns: [/(?:安全防护|安全措施|保护措施|safeguard).{0,80}(?:风险|危险|事故|泄漏|压力|化学)/iu],
    negativePatterns: [/(?:安全防护|安全措施|保护措施|safeguard).{0,20}(?:缺少|未填写|未提供)/iu],
    notApplicablePatterns: [],
    autoResolve: false,
  }),
  defineRule("rule_violations", {
    label: "竞赛规则符合性",
    documentRoles: CORE_EDP_DOCUMENTS,
    positivePatterns: [/(?:符合|遵守).{0,24}(?:竞赛|Chem-E-Car).{0,16}(?:规则|要求)|(?:无|没有|不存在).{0,16}(?:违规|违反规则)/iu],
    negativePatterns: [/(?:违反|不符合).{0,24}(?:竞赛|Chem-E-Car).{0,16}(?:规则|要求)|(?:违规|违反规则).{0,20}(?:存在|发现)/iu],
    notApplicablePatterns: [],
    autoResolve: false,
  }),
  defineRule("moc", {
    label: "变更管理（MOC）",
    documentRoles: ["moc"],
    positivePatterns: [/(?:变更管理|MOC|management of change).{0,80}(?:变更|修改|影响|评估|批准)/iu],
    negativePatterns: [/(?:变更管理|MOC).{0,24}(?:缺少|未填写|未提供)/iu],
    notApplicablePatterns: [/(?:无|没有|未发生|不涉及).{0,20}(?:变更|修改)|(?:变更管理|MOC).{0,20}(?:不适用|N\/?A)/iu],
    autoResolve: false,
  }),
  defineRule("aisle", {
    label: "通道与疏散空间",
    documentRoles: CORE_EDP_DOCUMENTS,
    positivePatterns: [/(?:通道|走道|过道|aisle).{0,40}(?:畅通|无遮挡|足够|宽度|疏散)/iu],
    negativePatterns: [/(?:通道|走道|过道|aisle).{0,40}(?:堵塞|遮挡|不足|过窄)/iu],
    notApplicablePatterns: [],
    autoResolve: false,
  }),
  defineRule("emergency_equipment", {
    label: "应急设备布置",
    documentRoles: CORE_EDP_DOCUMENTS,
    positivePatterns: [/(?:应急设备|紧急设备|emergency equipment).{0,60}(?:位置|布置|放置|灭火器|洗眼器|急救)/iu],
    negativePatterns: [/(?:应急设备|紧急设备|emergency equipment).{0,24}(?:缺少|未提供|未设置)/iu],
    notApplicablePatterns: [],
    autoResolve: false,
  }),
  defineRule("sop", {
    label: "标准操作程序（SOP）",
    documentRoles: CORE_EDP_DOCUMENTS,
    positivePatterns: [/(?:标准操作程序|SOP|standard operating procedure).{0,80}(?:启动|运行|操作|停车|应急)/iu],
    negativePatterns: [/(?:标准操作程序|SOP).{0,20}(?:缺少|未填写|未提供)/iu],
    notApplicablePatterns: [],
    autoResolve: true,
  }),
  defineRule("chemical_waste_sop", {
    label: "危险化学品及废弃物处置 SOP",
    documentRoles: CORE_EDP_DOCUMENTS,
    positivePatterns: [/(?:危险化学品|化学品).{0,30}(?:废弃物|废液|废物).{0,40}(?:SOP|操作程序|处置|处理)/iu],
    negativePatterns: [/(?:危险化学品|化学废弃物|化学废液).{0,30}(?:处置|处理|SOP).{0,20}(?:缺少|未提供|未制定)/iu],
    notApplicablePatterns: [],
    autoResolve: false,
  }),
  defineRule("post_competition_cleanup", {
    label: "赛后化学品清理",
    documentRoles: CORE_EDP_DOCUMENTS,
    positivePatterns: [/(?:赛后|比赛结束后|竞赛结束后).{0,40}(?:化学品|废液|废弃物).{0,30}(?:清理|回收|处置|带离)/iu],
    negativePatterns: [/(?:赛后|比赛结束后|竞赛结束后).{0,40}(?:化学品|废液|废弃物).{0,20}(?:未清理|不处理|无计划)/iu],
    notApplicablePatterns: [],
    autoResolve: false,
  }),
  defineRule("certification_signatures", {
    label: "指导教师或外部专家认证签署",
    documentRoles: CORE_EDP_DOCUMENTS,
    positivePatterns: [/(?:指导教师|外部专家|instructor|external expert).{0,40}(?:签字|签署|签名|signed).{0,30}(?:认证|声明|证明|EDP)/iu],
    negativePatterns: [/(?:认证|声明|证明).{0,30}(?:未签字|缺少签字|未签署)/iu],
    notApplicablePatterns: [],
    autoResolve: false,
  }),
  defineRule("ten_hours_experience", {
    label: "团队至少 10 小时操作经验",
    documentRoles: CORE_EDP_DOCUMENTS,
    positivePatterns: [/(?:团队|队员|成员).{0,40}(?:至少|不少于|≥|>=)\s*10\s*(?:个)?(?:小时|h(?:ours?)?).{0,30}(?:操作|运行|实践|经验)/iu],
    negativePatterns: [/(?:团队|队员|成员).{0,40}(?:少于|不足|<)\s*10\s*(?:个)?(?:小时|h(?:ours?)?).{0,30}(?:操作|运行|实践|经验)/iu],
    notApplicablePatterns: [],
    autoResolve: true,
  }),
]);

type EvidenceKind = "positive" | "negative" | "not_applicable";

function safePattern(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.replace(/[gy]/gu, ""));
}

function evidenceExcerpt(text: string, matchIndex: number, matchLength: number): string {
  const compact = text.replace(/\s+/gu, " ").trim();
  const normalizedIndex = Math.max(0, Math.min(matchIndex, compact.length));
  const start = Math.max(0, normalizedIndex - 80);
  const end = Math.min(compact.length, normalizedIndex + Math.max(matchLength, 1) + 140);
  const excerpt = compact.slice(start, end).trim();
  return `${start > 0 ? "…" : ""}${excerpt}${end < compact.length ? "…" : ""}`.slice(0, 240);
}

function collectEvidence(
  patterns: readonly RegExp[],
  documents: readonly EdpReviewDocument[],
): EdpReviewEvidence[] {
  const evidence: EdpReviewEvidence[] = [];
  for (const document of documents) {
    for (let pageIndex = 0; pageIndex < document.pages.length; pageIndex += 1) {
      const pageText = document.pages[pageIndex] ?? "";
      for (const pattern of patterns) {
        const match = safePattern(pattern).exec(pageText);
        if (!match) continue;
        evidence.push({
          documentRole: document.role,
          filename: document.filename,
          page: pageIndex + 1,
          excerpt: evidenceExcerpt(pageText, match.index, match[0].length),
        });
        break;
      }
    }
  }
  return evidence;
}

function statusComment(status: EdpReviewStatus, evidence: readonly EdpReviewEvidence[]): string {
  if (status === "needs_human") {
    return evidence.length > 0 ? "存在相关或相互冲突的文字证据，请人工核对原文。" : "未找到足以自动判定的明确文字证据，请人工核对。";
  }
  if (status === "yes") return "已找到明确的符合性文字证据。";
  if (status === "no") return "已找到明确的不符合性文字证据。";
  return "文件明确说明该项不适用。";
}

export function resolveEdpReviewRule(
  rule: EdpReviewRule,
  documents: readonly EdpReviewDocument[],
): EdpReviewRuleResult {
  const relevantDocuments = documents.filter((document) => rule.documentRoles.includes(document.role));
  const usableDocuments = relevantDocuments.filter((document) => document.textQuality === "usable");
  const hasUnreadableRelevantDocument = relevantDocuments.some((document) => document.textQuality !== "usable");
  const evidenceByKind: Record<EvidenceKind, EdpReviewEvidence[]> = {
    positive: collectEvidence(rule.positivePatterns, usableDocuments),
    negative: collectEvidence(rule.negativePatterns, usableDocuments),
    not_applicable: collectEvidence(rule.notApplicablePatterns, usableDocuments),
  };
  const matchedKinds = (Object.keys(evidenceByKind) as EvidenceKind[]).filter((kind) => evidenceByKind[kind].length > 0);
  const evidence = matchedKinds.flatMap((kind) => evidenceByKind[kind]);

  let status: EdpReviewStatus = "needs_human";
  if (!hasUnreadableRelevantDocument && rule.autoResolve && matchedKinds.length === 1) {
    if (matchedKinds[0] === "positive") status = "yes";
    if (matchedKinds[0] === "negative") status = "no";
    if (matchedKinds[0] === "not_applicable") status = "not_applicable";
  }

  return {
    ruleId: rule.id,
    row: rule.row,
    status,
    isBlocking: rule.isBlocking,
    ruleSource: rule.ruleSource,
    evidence,
    suggestedComment: rule.id === "vehicle_photo"
      ? "小车完整照片暂缓审核，本项保留待人工确认但不阻塞当前阶段的正式结论。"
      : statusComment(status, evidence),
  };
}
