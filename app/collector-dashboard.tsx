"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import CertificateWorkspace from "./certificate-workspace";
import { createAutosave, type SaveState } from "./schedule-autosave";
import { drainFankeQueue, type FankeQueueResult } from "./fanke-queue-client";

type Workspace = "registration" | "edp" | "edpReview" | "mail" | "poster" | "video" | "certificate";
type MediaKind = "poster" | "video";
type ScheduledWorkspace = "registration" | "edp" | MediaKind;
type FrequencyUnit = "hours" | "days" | "weeks";
type Notice = { kind: "success" | "error" | "info"; text: string } | null;
type AuthState = "checking" | "authenticated" | "unauthenticated";

type AuthStatusResponse = {
  ok?: true;
  authenticated: boolean;
  founderManagementEnabled?: boolean;
  passwordVersion?: number;
};

type FounderPasswordResponse = AuthStatusResponse & {
  changed?: boolean;
  message?: string;
};

type ApiSettings = {
  startsAt: string | null;
  runTime: string;
  timezone: string;
  intervalMinutes: number;
  enabled: boolean;
  nextRunAt: string | null;
};

type ScheduleForm = {
  startDate: string;
  runTime: string;
  frequencyValue: number;
  frequencyUnit: FrequencyUnit;
  timezone: string;
  enabled: boolean;
};

type MasterFile = {
  filename: string;
  size: number;
  uploadedAt: string;
  downloadUrl: string;
};

type RegistrationReceipt = {
  status: "qualified" | "unqualified" | "needs_review";
  recipientEmail: string;
  subject: string;
  body: string;
  settingsComplete: boolean;
  requiresReassessment: boolean;
  teacherCount: number;
  studentCount: number;
  reasons: string[];
  assessedAt: string | null;
};

type AlibabaDraft = {
  schoolName: string;
  recipient: string;
  subject: string;
  body: string;
};

type RegistrationReceiptSettings = {
  competitionYear: string;
  qqGroup: string;
  updatedAt: string | null;
};

type EdpSubmissionRound = 1 | 2 | 3 | 4 | 5;

type EdpReceiptSettings = {
  competitionYear: string;
  submissionRound: EdpSubmissionRound | null;
  updatedAt: string | null;
};

type EdpReceipt = {
  status: "qualified" | "unqualified" | "needs_configuration";
  recipientEmail: string;
  subject: string;
  body: string;
  settingsComplete: boolean;
  competitionYear: string;
  submissionRound: EdpSubmissionRound | null;
  expectedFileCount: number | null;
  reasons: string[];
  assessedAt: string | null;
};

type RegistrationFile = {
  schoolKey: string;
  schoolName: string;
  filename: string;
  submittedAt: string;
  submissionId: string;
  size: number;
  uploadedAt: string;
  downloadUrl: string;
  receipt: RegistrationReceipt;
};

type EdpSubmission = Omit<RegistrationFile, "receipt"> & {
  fileCount?: number;
  formats?: string[];
  formatSummary?: string;
  archiveFormat: "zip" | "7z" | "rar";
  submissionRound: EdpSubmissionRound | null;
  submissionRoundSource: "captured" | "legacy_unknown" | "inferred_file_count" | "inferred_current_setting";
  documentRoles: Array<"chinese_edp" | "english_edp" | "supplement" | "moc">;
  embeddedRegistration: {
    filename: string | null;
    status: "none" | "synced" | "older" | "invalid";
    message: string | null;
  };
  reviewTaskStatus: "created" | "missing";
  receipt: EdpReceipt;
};

type EdpIssue = {
  schoolKey?: string;
  schoolName: string;
  filename?: string;
  submittedAt?: string;
  submissionId?: string;
  fileCount?: number;
  formats?: string[];
  reason?: string;
  reasonCode?: "file_count" | "file_format" | "classification";
  reasonCodes?: string[];
  reasons?: string[];
  formatReason?: string;
  createdAt?: string;
  message?: string;
  downloadUrl?: string;
  receipt: EdpReceipt;
};

type MediaRecord = {
  id?: string;
  kind?: MediaKind;
  schoolKey?: string;
  schoolName: string;
  filename: string;
  submittedAt: string;
  submissionId: string;
  size: number;
  uploadedAt?: string;
  contentType?: string;
  downloadUrl: string;
  source?: "website" | "mail" | string;
};

type MailSettings = ApiSettings & {
  email: string;
  imapHost: string;
  imapPort: number;
  credentialConfigured: boolean;
  lastSyncAt?: string | null;
};

type MailAttachment = {
  id?: string;
  filename: string;
  size?: number;
  contentType?: string;
  downloadUrl: string;
  deleteUrl?: string;
  collectedAt?: string;
};

type MailMessage = {
  id?: string;
  messageId?: string;
  uid?: string | number;
  subject?: string;
  sender?: string;
  from?: string;
  fromName?: string;
  fromAddress?: string;
  schoolName?: string;
  receivedAt?: string;
  sentAt?: string;
  createdAt?: string;
  attachments?: MailAttachment[];
};

type MailIssue = {
  id?: string;
  messageId?: string;
  schoolName?: string;
  subject?: string;
  sender?: string;
  fromAddress?: string;
  reason?: string;
  message?: string;
  createdAt?: string;
};

type MailMediaCandidate = {
  id?: string | number;
  candidateId?: string | number;
  candidate_id?: string | number;
  attachmentId?: string | number;
  filename?: string;
  attachmentName?: string;
  kind?: MediaKind | string;
  mediaKind?: MediaKind | string;
  contentType?: string;
  subject?: string;
  sender?: string;
  from?: string;
  fromName?: string;
  fromAddress?: string;
  receivedAt?: string;
  received_at?: string;
  sentAt?: string;
  createdAt?: string;
  schoolName?: string;
  inferredSchoolName?: string;
  inferred_school_name?: string;
  suggestedSchoolName?: string;
  guessedSchoolName?: string;
  reason?: string;
  inferenceReason?: string;
  reviewReason?: string;
  reasons?: string[];
  status?: "pending" | "retry" | "processing" | "assigned" | "dismissed" | "invalid" | string;
  reasonMessage?: string;
  downloadUrl?: string;
  download_url?: string;
};

type MailMediaCandidatesResponse = {
  ok?: true;
  candidates?: MailMediaCandidate[];
  items?: MailMediaCandidate[];
  mailMediaCandidates?: MailMediaCandidate[];
  data?: { candidates?: MailMediaCandidate[]; items?: MailMediaCandidate[] };
};

type BrowserMailCheckpoint = {
  kind: MediaKind;
  mailboxKey: string;
  lastMessageKey: string | null;
  lastScanAt: string | null;
  lastError: string | null;
  startsAt: string | null;
  timezone: string;
  updatedAt: string;
};

type BrowserMailStateResponse = {
  ok: true;
  checkpoints: BrowserMailCheckpoint[];
  counts: Record<string, number>;
};

type EdpReviewStatus = "yes" | "no" | "not_applicable" | "needs_human";
type EdpReviewOverallStatus = "pending" | "passed" | "failed" | "needs_human";
type EdpReviewJobStatus = "queued" | "processing" | "needs_human" | "ready" | "completed" | "failed" | "superseded";

type EdpReviewSettings = {
  competitionYear: string;
  safetyReviewerName: string;
  safetyReviewerEmail: string;
  expertMemberName: string;
  templateVersion: string;
  activeRuleDocumentId: string | null;
  activeRuleVersion: string | null;
  updatedAt: string | null;
};

type EdpReviewJob = {
  jobId: string;
  schoolKey: string;
  schoolName: string;
  submissionId: string;
  submittedAt: string;
  submissionRound: EdpSubmissionRound;
  submissionRoundSource: "captured" | "legacy_unknown" | "inferred_file_count" | "inferred_current_setting" | null;
  archiveFormat: "zip" | "7z" | "rar" | null;
  sourceFilename: string | null;
  ruleVersion: string;
  templateVersion: string;
  status: EdpReviewJobStatus;
  overallStatus: EdpReviewOverallStatus;
  supersededBy: string | null;
  lastError: string | null;
  reviewedAt: string | null;
  finalizedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type EdpReviewSyncSummary = {
  created: number;
  existing: number;
  failed: number;
  historicalRoundInferences: number;
  failures: Array<{ schoolKey: string; schoolName: string; message: string }>;
};

type EdpReviewEvidence = {
  documentRole: "chinese_edp" | "english_edp" | "supplement" | "moc";
  filename: string;
  page: number;
  excerpt: string;
};

type EdpReviewItem = {
  ruleId: string;
  worksheetName: string;
  templateRow: number;
  automaticStatus: EdpReviewStatus;
  finalStatus: EdpReviewStatus;
  status: EdpReviewStatus;
  suggestedComment: string;
  finalComment: string;
  evidence: EdpReviewEvidence[];
  documentName: string | null;
  pageNumber: number | null;
  isBlocking: boolean;
  ruleSource: string;
  overridden: boolean;
  overrideActor: string | null;
  overriddenAt: string | null;
};

type EdpReviewExport = {
  type: "draft" | "final";
  filename: string;
  size: number;
  generatedAt: string;
  downloadUrl: string;
};

type EdpReviewDetail = {
  job: EdpReviewJob;
  items: EdpReviewItem[];
  exports: EdpReviewExport[];
};

type EdpRuleDocumentStatus = "processing" | "needs_confirmation" | "active" | "archived" | "failed";

type EdpRuleDocument = {
  documentId: string;
  applicableYear: number;
  enteredYear: number;
  detectedYear: number | null;
  filename: string;
  size: number;
  status: EdpRuleDocumentStatus;
  warnings: string[];
  parseError: string | null;
  ruleVersion: string;
  yearConflict: boolean;
  yearConflictConfirmed: boolean;
  factCount: number;
  activatedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  downloadUrl: string;
};

type EdpRuleFact = {
  factId: string;
  category: string;
  section: string;
  normalizedRequirement: string;
  operator: string;
  value: string | null;
  unit: string | null;
  condition: string | null;
  page: number;
  excerpt: string;
  confidence: "high" | "medium" | "low";
  confirmationStatus: "pending" | "confirmed" | "rejected";
};

type EdpRuleDetail = {
  document: EdpRuleDocument;
  facts: EdpRuleFact[];
  changes: { added: string[]; removed: string[]; changed: string[] };
  comparedWithDocumentId: string | null;
};

type FankeKind = Exclude<Workspace, "mail" | "edpReview" | "certificate">;
type FankeCollectibleKind = "registration" | "edp";
const REQUIRED_FANKE_HELPER_VERSION = "1.5.0";
const SCHOOL_PINYIN_COLLATOR = new Intl.Collator("zh-CN-u-co-pinyin", { numeric: true, sensitivity: "base" });
const ALIMAIL_DRAFT_BATCH_SIZE = 5;
const FIXED_EDP_REVIEW_PERSONNEL = {
  safetyReviewerName: "潘芳丽",
  safetyReviewerEmail: "service@chemecar.cn",
  expertMemberName: "华炜",
} as const;

const EDP_DOCUMENT_ROLE_LABELS = {
  chinese_edp: "中文版 EDP",
  english_edp: "英文版 EDP",
  supplement: "EDP 增补文件",
  moc: "MOC",
} as const;

const EDP_REVIEW_STATUS_LABELS: Record<EdpReviewStatus, string> = {
  yes: "是",
  no: "否",
  not_applicable: "不适用",
  needs_human: "待人工确认",
};

const EDP_REVIEW_RULE_LABELS: Record<string, string> = {
  chemical_sds: "化学物质、Chemical Information 与 SDS 一致性",
  ppe: "个人防护装备",
  reactions_overview: "全部反应概述",
  onsite_hydrogen: "现场制氢压力低于 0.345 bar",
  operating_principle: "车辆工作原理",
  vehicle_photo: "完整车辆照片",
  syringes_fixed: "注射器固定且不可拆卸",
  secondary_containment: "二次容纳空间足够",
  component_specs: "零部件、温度与压力参数",
  commercial_component_docs: "商用部件制造商资料",
  pressure_vessel_certificate: "压力容器认证或水压试验",
  no_plastic_pressure: "承压系统不使用塑料或 PVC",
  mawp_gt_mop: "MAWP 高于 MOP",
  plastic_pressure_test_docs: "塑料管制造商压力试验资料",
  pressure_relief_device: "适当的压力释放装置",
  unknown_mawp_external_cert: "未知 MAWP 的外部商业认证",
  instructor_signed_relief_basis: "指导教师签署泄压计算依据",
  relief_sizing: "泄压装置选型与负荷计算",
  relief_test: "泄压装置试验与结果",
  max_pressure_500psig: "最大操作压力不超过 500 psig",
  hazard_types: "危险类型识别",
  jsa: "作业安全分析（JSA）",
  safeguards: "安全防护措施",
  rule_violations: "竞赛规则符合性",
  moc: "变更管理（MOC）",
  aisle: "通道与疏散空间",
  emergency_equipment: "应急设备布置",
  sop: "标准操作程序（SOP）",
  chemical_waste_sop: "危险化学品及废弃物处置 SOP",
  post_competition_cleanup: "赛后化学品清理",
  certification_signatures: "指导教师或外部专家认证签署",
  ten_hours_experience: "团队至少 10 小时操作经验",
  cover_required_fields: "封面八项必填信息",
  cover_bilingual_consistency: "中英文封面一致性",
  cover_registration_consistency: "封面与最新报名表一致性",
  bilingual_objective_consistency: "中英文客观信息一致性",
  power_equation_logic: "动力反应方程式与推进逻辑",
  control_equation_logic: "控制反应方程式与停止逻辑",
  auxiliary_process: "辅助过程及安全条件",
  risks_and_mitigations: "潜在风险与预防减轻措施",
  innovation_statement: "本年方案创新点",
  outlet_requirement: "比赛现场电源插座要求",
  sop_stages: "SOP 六个关键阶段",
  sop_four_columns: "SOP 四类必填信息",
  sop_quantification: "SOP 化学品与操作定量化",
  waste_handling_detail: "废物分类、容器、标签与去向",
  previous_five_years: "近五年动力与控制方案",
  hazards_analysis_completed: "英文版危险分析",
  laboratory_floor_plan: "英文版实验室平面图",
  primary_hazards_checklist: "英文版主要危险清单",
  training_certificate_coverage: "参赛成员与指导教师安全培训证书",
  equipment_list_completeness: "设备清单与制造商资料",
  hydrogen_calculation_applicability: "氢气/可燃物排放计算适用性",
  pressure_calculation_applicability: "压力计算适用性",
  capital_cost_completeness: "车辆资本成本完整性",
  waste_tag_consistency: "废物流与 Team Waste Tags 一致性",
};

const EDP_REVIEW_GROUPS = [
  { id: "cover", label: "首页与报名信息" },
  { id: "safety", label: "工作安全评估" },
  { id: "englishSafety", label: "英文版专属安全章节" },
  { id: "chemistry", label: "化学品、设备与增补文件" },
  { id: "calculations", label: "计算、成本与废物" },
  { id: "sop", label: "标准安全操作" },
  { id: "history", label: "近五年方案" },
  { id: "other", label: "其他规则" },
] as const;

function edpReviewGroup(item: EdpReviewItem): (typeof EDP_REVIEW_GROUPS)[number]["id"] {
  if (item.worksheetName === "1) EDP Cover Page" || item.ruleId.startsWith("cover_") || item.ruleId === "bilingual_objective_consistency") return "cover";
  if (item.ruleId === "previous_five_years") return "history";
  if (["hazards_analysis_completed", "laboratory_floor_plan", "primary_hazards_checklist"].includes(item.ruleId)) return "englishSafety";
  if (["chemical_sds", "training_certificate_coverage", "equipment_list_completeness", "component_specs", "commercial_component_docs", "certification_signatures", "moc"].includes(item.ruleId)) return "chemistry";
  if (["hydrogen_calculation_applicability", "pressure_calculation_applicability", "capital_cost_completeness", "waste_tag_consistency", "onsite_hydrogen", "pressure_vessel_certificate", "no_plastic_pressure", "mawp_gt_mop", "plastic_pressure_test_docs", "pressure_relief_device", "unknown_mawp_external_cert", "instructor_signed_relief_basis", "relief_sizing", "relief_test", "max_pressure_500psig"].includes(item.ruleId)) return "calculations";
  if (["sop", "sop_stages", "sop_four_columns", "sop_quantification", "chemical_waste_sop", "waste_handling_detail", "post_competition_cleanup"].includes(item.ruleId)) return "sop";
  if (["power_equation_logic", "control_equation_logic", "auxiliary_process", "risks_and_mitigations", "innovation_statement", "outlet_requirement", "hazard_types", "jsa", "safeguards", "operating_principle"].includes(item.ruleId)) return "safety";
  return "other";
}

function edpRuleStatusLabel(status: EdpRuleDocumentStatus): string {
  if (status === "active") return "当前启用";
  if (status === "archived") return "历史归档";
  if (status === "needs_confirmation") return "等待确认";
  if (status === "failed") return "解析失败";
  return "正在解析";
}

function normalizeReceiptEmail(value: string): string {
  return value.normalize("NFKC").trim();
}

function isValidReceiptEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalizeReceiptEmail(value));
}

function isEdpSubmissionRound(value: number | null): value is EdpSubmissionRound {
  return value !== null && Number.isInteger(value) && value >= 1 && value <= 5;
}

function parseEdpSubmissionRound(value: string): EdpSubmissionRound | null {
  const round = Number(value);
  return isEdpSubmissionRound(round) ? round : null;
}

function edpReceiptRuleText(round: EdpSubmissionRound | null): string {
  if (round === null) return "请选择第 1–5 次提交；系统会显示对应的 PDF 数量要求。";
  return round === 1
    ? "第 1 次提交必须有 3 个 PDF：中文版、英文版和 EDP 增补文件，不含 MOC。"
    : `第 ${round} 次提交必须有 4 个 PDF：中文版、英文版、EDP 增补文件和 MOC。`;
}

function edpReceiptSettingsComplete(settings: EdpReceiptSettings): boolean {
  return /^20\d{2}$/u.test(settings.competitionYear)
    && isEdpSubmissionRound(settings.submissionRound);
}

function compareSubmissionVersion(
  left: { submittedAt?: string; submissionId?: string },
  right: { submittedAt?: string; submissionId?: string },
): number {
  const timeOrder = (left.submittedAt || "").localeCompare(right.submittedAt || "");
  if (timeOrder !== 0) return timeOrder;
  const leftId = (left.submissionId || "").replace(/^0+(?=\d)/u, "");
  const rightId = (right.submissionId || "").replace(/^0+(?=\d)/u, "");
  if (/^\d+$/u.test(leftId) && /^\d+$/u.test(rightId)) {
    if (leftId.length !== rightId.length) return leftId.length - rightId.length;
  }
  return leftId.localeCompare(rightId);
}

function helperVersionAtLeast(version: string, required = REQUIRED_FANKE_HELPER_VERSION): boolean {
  const current = version.split(".").map((part) => Number(part));
  const target = required.split(".").map((part) => Number(part));
  if (current.some((part) => !Number.isInteger(part) || part < 0)) return false;
  for (let index = 0; index < Math.max(current.length, target.length); index += 1) {
    const difference = (current[index] || 0) - (target[index] || 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

type FankeDashboard = {
  connected: boolean;
  connector?: {
    formId?: string | null;
    enabled: boolean;
    secretPrefix?: string;
    lastEventAt?: string | null;
    lastProcessedAt?: string | null;
    lastError?: string | null;
  } | null;
  counts?: Record<string, number>;
  recentFiles?: Array<{
    queueId: string;
    schoolName: string;
    filename: string;
    kind: FankeKind;
    status: string;
    submittedAt: string;
    lastError?: string | null;
  }>;
  problemFiles?: Array<{
    queueId: string;
    schoolName: string;
    filename: string;
    kind: FankeKind;
    status: string;
    submittedAt: string;
    lastError?: string | null;
  }>;
  issues?: Array<{
    id: string;
    schoolName?: string | null;
    message: string;
    receivedAt: string;
  }>;
  assistant?: {
    formId: string;
    scanId: string;
    targetKind: FankeKind;
    status: "running" | "completed" | "failed";
    totalRecords: number;
    newRecords: number;
    changedRecords: number;
    unchangedRecords: number;
    queuedFiles: number;
    unclassifiedFiles: number;
    startedAt: string;
    completedAt?: string | null;
    lastError?: string | null;
  } | null;
};

type DashboardResponse = {
  ok: true;
  settings: ApiSettings;
  master: MasterFile | null;
  registrations: RegistrationFile[];
  registrationReceiptSettings?: RegistrationReceiptSettings;
  summary: { schoolCount: number; hasMaster: boolean; enabled: boolean };
  edpSettings?: ApiSettings;
  edpReceiptSettings?: EdpReceiptSettings;
  edpSubmissions?: EdpSubmission[];
  edpIssues?: EdpIssue[];
  assets?: MediaRecord[];
  mediaAssets?: MediaRecord[];
  media?: {
    posters?: MediaRecord[];
    videos?: MediaRecord[];
    assets?: MediaRecord[];
    settings?: { poster?: ApiSettings; video?: ApiSettings };
  };
  mediaSettings?: { poster?: ApiSettings; video?: ApiSettings };
  mailMediaCandidates?: MailMediaCandidate[];
  mediaCandidates?: MailMediaCandidate[];
  mail?: {
    settings?: MailSettings;
    messages?: MailMessage[];
    issues?: MailIssue[];
    nextCursor?: string | null;
    mediaCandidates?: MailMediaCandidate[];
    candidates?: MailMediaCandidate[];
  };
  fanke?: FankeDashboard;
};

const defaultRegistrationReceiptSettings: RegistrationReceiptSettings = {
  competitionYear: "",
  qqGroup: "",
  updatedAt: null,
};

const defaultEdpReceiptSettings: EdpReceiptSettings = {
  competitionYear: "",
  submissionRound: null,
  updatedAt: null,
};

const defaultEdpReviewSettings: EdpReviewSettings = {
  competitionYear: "",
  ...FIXED_EDP_REVIEW_PERSONNEL,
  templateVersion: "v1",
  activeRuleDocumentId: null,
  activeRuleVersion: null,
  updatedAt: null,
};

const defaultApiSettings: ApiSettings = {
  startsAt: null,
  runTime: "09:00",
  timezone: "Asia/Shanghai",
  intervalMinutes: 1440,
  enabled: false,
  nextRunAt: null,
};

const defaultSchedule: ScheduleForm = {
  startDate: "",
  runTime: "09:00",
  frequencyValue: 1,
  frequencyUnit: "days",
  timezone: "Asia/Shanghai",
  enabled: false,
};

const defaultMailSettings: MailSettings = {
  ...defaultApiSettings,
  email: "",
  imapHost: "imap.qiye.aliyun.com",
  imapPort: 993,
  credentialConfigured: false,
};

function intervalToFrequency(intervalMinutes: number): Pick<ScheduleForm, "frequencyValue" | "frequencyUnit"> {
  const safeMinutes = Number.isFinite(intervalMinutes) && intervalMinutes > 0 ? intervalMinutes : 1440;
  if (safeMinutes % 10080 === 0) return { frequencyValue: safeMinutes / 10080, frequencyUnit: "weeks" };
  if (safeMinutes % 1440 === 0) return { frequencyValue: safeMinutes / 1440, frequencyUnit: "days" };
  return { frequencyValue: Math.max(1, Math.round(safeMinutes / 60)), frequencyUnit: "hours" };
}

function frequencyToMinutes(value: number, unit: FrequencyUnit) {
  const multiplier: Record<FrequencyUnit, number> = { hours: 60, days: 1440, weeks: 10080 };
  return Math.max(1, Math.round(value)) * multiplier[unit];
}

function browserMailScanIsDue(schedule: ScheduleForm, lastScanAt: string | null, now = new Date()): boolean {
  if (!schedule.enabled || !schedule.startDate) return false;
  const intervalMinutes = frequencyToMinutes(schedule.frequencyValue, schedule.frequencyUnit);
  const lastScanTime = lastScanAt ? new Date(lastScanAt).getTime() : Number.NaN;
  if (Number.isFinite(lastScanTime) && now.getTime() - lastScanTime < intervalMinutes * 60_000) return false;
  if (intervalMinutes < 1440) return true;

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: schedule.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value || "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value || "0");
  const [scheduledHour, scheduledMinute] = schedule.runTime.split(":").map((value) => Number(value));
  return hour * 60 + minute >= (Number.isFinite(scheduledHour) ? scheduledHour : 0) * 60 + (Number.isFinite(scheduledMinute) ? scheduledMinute : 0);
}

function scheduleFromApi(settings: ApiSettings): ScheduleForm {
  const frequency = intervalToFrequency(settings.intervalMinutes);
  return {
    startDate: settings.startsAt?.match(/^\d{4}-\d{2}-\d{2}/)?.[0] || "",
    runTime: settings.runTime || "09:00",
    frequencyValue: frequency.frequencyValue,
    frequencyUnit: frequency.frequencyUnit,
    timezone: "Asia/Shanghai",
    enabled: settings.enabled === true,
  };
}

function frequencySummary(schedule: ScheduleForm) {
  const units: Record<FrequencyUnit, string> = { hours: "小时", days: "天", weeks: "周" };
  return `每 ${schedule.frequencyValue} ${units[schedule.frequencyUnit]}一次`;
}

function formatDate(value?: string | null) {
  if (!value) return "尚未记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatSize(bytes?: number) {
  if (!bytes || !Number.isFinite(bytes)) return "大小未知";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function edpReviewOverallLabel(status: EdpReviewOverallStatus) {
  const labels: Record<EdpReviewOverallStatus, string> = {
    pending: "等待审核",
    passed: "审核通过",
    failed: "审核未通过",
    needs_human: "待人工确认",
  };
  return labels[status];
}

function edpReviewJobLabel(status: EdpReviewJobStatus, overallStatus: EdpReviewOverallStatus) {
  if (status === "queued") return "等待首次审核";
  if (status === "processing") return "正在审核";
  if (status === "failed") return "审核运行失败";
  if (status === "superseded") return "已被新版取代";
  if (status === "completed") return `已定稿 · ${edpReviewOverallLabel(overallStatus)}`;
  return edpReviewOverallLabel(overallStatus);
}

function edpRoundSourceLabel(source: EdpSubmission["submissionRoundSource"] | EdpReviewJob["submissionRoundSource"]) {
  if (source === "captured") return "提交时记录";
  if (source === "inferred_file_count") return "按 3 个文件推断";
  if (source === "inferred_current_setting") return "按当前轮次补全";
  return "历史记录";
}

function embeddedRegistrationLabel(status: EdpSubmission["embeddedRegistration"]["status"]) {
  if (status === "synced") return "已更新报名表栏目";
  if (status === "older") return "已有更新报名表，未覆盖";
  if (status === "invalid") return "随包报名表未通过检查，EDP 不受影响";
  return "未附报名表";
}

function mailMessageKey(message: MailMessage) {
  const stableId = message.id ?? message.messageId ?? message.uid;
  if (stableId !== undefined && stableId !== null && String(stableId)) return `id:${String(stableId)}`;
  const sender = message.sender || message.from || message.fromAddress || "";
  const receivedAt = message.receivedAt || message.sentAt || message.createdAt || "";
  const attachments = (message.attachments || []).map((item) => item.id || item.filename).join("|");
  return `fallback:${message.subject || ""}|${sender}|${receivedAt}|${attachments}`;
}

function appendUniqueMailMessages(current: MailMessage[], incoming: MailMessage[]) {
  const seen = new Set(current.map(mailMessageKey));
  const next = [...current];
  for (const message of incoming) {
    const key = mailMessageKey(message);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(message);
  }
  return next;
}

function mediaSourceLabel(source?: string, submissionId?: string) {
  if (submissionId?.startsWith("fanke-")) return "凡科";
  const normalized = source?.toLocaleLowerCase("en-US");
  return normalized === "mail" || normalized === "email" ? "邮箱" : "网站";
}

function mediaFormatLabel(filename: string, kind: MediaKind) {
  const extension = filename.split(".").pop()?.toLocaleUpperCase("en-US") || "";
  if (["ZIP", "7Z", "RAR", "AI", "JPG", "JPEG", "MP4"].includes(extension)) {
    return extension === "JPEG" ? "JPG" : extension;
  }
  return kind === "video" ? "MP4" : "FILE";
}

function mailCandidateId(candidate: MailMediaCandidate) {
  const value = candidate.id ?? candidate.candidateId ?? candidate.candidate_id ?? candidate.attachmentId;
  return value === undefined || value === null ? "" : String(value);
}

function mailCandidateFilename(candidate: MailMediaCandidate) {
  return candidate.filename || candidate.attachmentName || "未命名附件";
}

function mailCandidateFormat(candidate: MailMediaCandidate) {
  const filename = mailCandidateFilename(candidate).toLocaleLowerCase("en-US");
  if (filename.endsWith(".zip")) return "ZIP";
  if (filename.endsWith(".7z")) return "7Z";
  if (filename.endsWith(".rar")) return "RAR";
  const declaredKind = (candidate.kind || candidate.mediaKind || "").toLocaleLowerCase("en-US");
  if (declaredKind === "video") return "MP4";
  if (declaredKind === "poster") {
    return filename.endsWith(".ai") ? "AI" : "JPG";
  }
  if (filename.endsWith(".mp4")) return "MP4";
  if (filename.endsWith(".ai")) return "AI";
  return "JPG";
}

function mailCandidateSchool(candidate: MailMediaCandidate) {
  return candidate.inferredSchoolName || candidate.inferred_school_name || candidate.suggestedSchoolName || candidate.guessedSchoolName || candidate.schoolName || "";
}

function mailCandidateSender(candidate: MailMediaCandidate) {
  return candidate.sender || candidate.from || [candidate.fromName, candidate.fromAddress].filter(Boolean).join(" <") + (candidate.fromName && candidate.fromAddress ? ">" : "") || "发件人未知";
}

function mailCandidateReason(candidate: MailMediaCandidate) {
  if (candidate.reasonMessage) return candidate.reasonMessage;
  const raw = candidate.reasons?.join("；") || candidate.reason || candidate.inferenceReason || candidate.reviewReason;
  const messages: Record<string, string> = {
    school_confirmation_required: "系统无法可靠确定所属学校，请人工确认。",
    multiple_known_schools_matched: "主题或文件名同时出现多所已知学校，请人工确认。",
    multiple_school_names_matched: "主题或文件名中识别到多个学校名称，请人工确认。",
    known_school_unique_match: "已唯一识别学校，系统将自动归档；您也可以立即确认。",
    explicit_school_name_match: "已从主题或文件名识别学校，系统将自动归档；您也可以立即确认。",
    media_import_in_progress: "系统正在把附件归入共享资料库。",
    mail_media_import_retry: "自动归档暂时失败，系统会重试；也可稍后人工确认。",
    invalid_jpeg_header: "JPG 文件格式不正确，文件未归入海报库。",
    invalid_ai_header: "AI 文件格式不正确，文件未归入海报库。",
    invalid_mp4_header: "MP4 文件格式不正确，文件未归入视频库。",
    invalid_zip_header: "ZIP 压缩包格式不正确，文件未归入资料库。",
    invalid_7z_header: "7z 压缩包格式不正确，文件未归入资料库。",
    invalid_rar_header: "RAR 压缩包格式不正确，文件未归入资料库。",
    poster_format_required: "附件不是有效的 AI、JPG、ZIP、7z 或 RAR 文件，未归入海报库。",
    video_format_required: "附件不是有效的 MP4、ZIP、7z 或 RAR 文件，未归入视频库。",
    before_collection_start: "附件早于该栏目的收集起始日期，未归入资料库。",
    file_too_large: "附件超过允许大小，未归入共享资料库。",
    empty_file: "附件为空文件，未归入共享资料库。",
  };
  return raw ? messages[raw] || raw : "系统无法确定该附件所属学校，请人工确认。";
}

function mailCandidateDownloadUrl(candidate: MailMediaCandidate) {
  return candidate.downloadUrl || candidate.download_url || "";
}

function candidatesFromResponse(response: MailMediaCandidatesResponse | MailMediaCandidate[] | null | undefined) {
  if (Array.isArray(response)) return response;
  return response?.candidates || response?.items || response?.mailMediaCandidates || response?.data?.candidates || response?.data?.items || [];
}

class ApiRequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
  }
}

const NETWORK_PROXY_MESSAGE = "无法连接服务器。请确认已开启 VPN/网络代理，然后刷新页面重试。";

function requestPath(input: RequestInfo | URL) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.pathname;
  return new URL(input.url, window.location.origin).pathname;
}

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(input, { credentials: "same-origin", ...init });
  } catch {
    throw new ApiRequestError(NETWORK_PROXY_MESSAGE, 0);
  }
  const payload = await response.json().catch(() => null) as ({
    error?: string | { message?: string };
    message?: string;
  } & Partial<T>) | null;
  if (!response.ok) {
    const nestedMessage = typeof payload?.error === "object" ? payload.error.message : undefined;
    const directMessage = typeof payload?.error === "string" ? payload.error : undefined;
    const path = requestPath(input);
    if (response.status === 401 && !path.startsWith("/api/auth/") && path !== "/api/founder/password") {
      window.dispatchEvent(new CustomEvent("collector-auth-expired"));
    }
    const networkFallback = !payload && [403, 502, 503, 504].includes(response.status)
      ? NETWORK_PROXY_MESSAGE
      : `请求失败（${response.status}）`;
    throw new ApiRequestError(
      directMessage || nestedMessage || payload?.message || networkFallback,
      response.status,
    );
  }
  if (!payload) throw new ApiRequestError(NETWORK_PROXY_MESSAGE, 0);
  return payload as T;
}

async function requestDownload(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(input, { credentials: "same-origin", ...init });
  } catch {
    throw new ApiRequestError(NETWORK_PROXY_MESSAGE, 0);
  }
  if (!response.ok) {
    const payload = await response.clone().json().catch(() => null) as {
      error?: string | { message?: string };
      message?: string;
    } | null;
    const nestedMessage = typeof payload?.error === "object" ? payload.error.message : undefined;
    const directMessage = typeof payload?.error === "string" ? payload.error : undefined;
    const path = requestPath(input);
    if (response.status === 401 && !path.startsWith("/api/auth/")) {
      window.dispatchEvent(new CustomEvent("collector-auth-expired"));
    }
    throw new ApiRequestError(
      directMessage || nestedMessage || payload?.message || `下载失败（${response.status}）`,
      response.status,
    );
  }
  return response;
}

function downloadFilename(response: Response, fallback: string): string {
  const disposition = response.headers.get("Content-Disposition") || "";
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/iu)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      // Fall through to a safe local filename.
    }
  }
  return fallback;
}

async function saveDownloadResponse(response: Response, fallback: string): Promise<void> {
  const objectUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = downloadFilename(response, fallback);
  anchor.hidden = true;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
}

function ScheduleFields({ schedule, onChange, enableLabel = "启用服务器凡科定时采集" }: { schedule: ScheduleForm; onChange: (next: ScheduleForm) => void; enableLabel?: string }) {
  return (
    <>
      <div className="schedule-fields">
        <label>只收集此日期及之后<input type="date" required={schedule.enabled} value={schedule.startDate} onChange={(event) => onChange({ ...schedule, startDate: event.target.value })} /></label>
        <label>执行时间<input type="time" required value={schedule.runTime} onChange={(event) => onChange({ ...schedule, runTime: event.target.value })} /></label>
        <label>频率数值<input type="number" min="1" step="1" required value={schedule.frequencyValue} onChange={(event) => onChange({ ...schedule, frequencyValue: Number(event.target.value) })} /></label>
        <label>频率单位<select value={schedule.frequencyUnit} onChange={(event) => onChange({ ...schedule, frequencyUnit: event.target.value as FrequencyUnit })}><option value="hours">小时</option><option value="days">天</option><option value="weeks">周</option></select></label>
      </div>
      <label className="enable-row"><input type="checkbox" checked={schedule.enabled} onChange={(event) => onChange({ ...schedule, enabled: event.target.checked })} /><span className="toggle-track" aria-hidden="true" />{enableLabel}</label>
    </>
  );
}

function CollectionStartField({ schedule, onChange, label }: { schedule: ScheduleForm; onChange: (next: ScheduleForm) => void; label: string }) {
  return <div className="schedule-fields start-date-only"><label>{label}收集起始日期<input type="date" required value={schedule.startDate} onChange={(event) => onChange({ ...schedule, startDate: event.target.value, enabled: false })} /></label><small>北京时间 · 修改后自动保存</small></div>;
}

function SaveIndicator({status,onRetry}: {status:SaveState | "";onRetry:()=>void}) {
  return <span role="status" aria-live="polite">{status === "error" ? <button type="button" className="ghost-action" onClick={onRetry}>保存失败，点击重试</button> : status === "pending" || status === "saving" ? "正在自动保存…" : status === "saved" ? "已自动保存" : "北京时间 · 修改后自动保存"}</span>;
}

function EmptyList({ title, detail }: { title: string; detail: string }) {
  return <div className="latest-empty"><span>{title}</span><p>{detail}</p></div>;
}

function BulkFileActions({
  label,
  allKeys,
  selectedKeys,
  busy,
  onToggleAll,
  onDelete,
}: {
  label: string;
  allKeys: string[];
  selectedKeys: string[];
  busy: boolean;
  onToggleAll: (checked: boolean) => void;
  onDelete: () => void;
}) {
  const selected = new Set(selectedKeys);
  const selectedCount = allKeys.filter((key) => selected.has(key)).length;
  const allSelected = allKeys.length > 0 && selectedCount === allKeys.length;
  return <div className="bulk-file-actions">
    <label><input type="checkbox" checked={allSelected} onChange={(event) => onToggleAll(event.target.checked)} /><span>{allSelected ? "取消全选" : `全选本栏 ${allKeys.length} 个文件`}</span></label>
    <span>已选择 {selectedCount} 个</span>
    <button className="danger-action" type="button" disabled={busy || selectedCount === 0} onClick={onDelete}>{busy ? "正在批量删除……" : `批量删除所选${label}`}</button>
  </div>;
}

function FankeControls({
  fanke,
  kind,
  label,
  helperInstalled,
  helperCompatible,
  helperVersion,
  helperProgress,
  busyAction,
  onStart,
  onOpenLibrary,
  onClearProblems,
  savedCounts,
  schedule,
  onScheduleChange,
  saveStatus,
  onRetrySave,
}: {
  fanke: FankeDashboard;
  kind: FankeCollectibleKind;
  label: string;
  helperInstalled: boolean;
  helperCompatible: boolean;
  helperVersion: string;
  helperProgress: string;
  busyAction: string | null;
  onStart: () => void;
  onOpenLibrary: (kind: FankeCollectibleKind) => void;
  onClearProblems: (kind: FankeCollectibleKind) => void;
  savedCounts: Record<FankeKind, number>;
  schedule: ScheduleForm;
  onScheduleChange: (next: ScheduleForm) => void;
  saveStatus: SaveState | "";
  onRetrySave: () => void;
}) {
  const pending = (fanke.counts?.[`${kind}:pending`] || 0) + (fanke.counts?.[`${kind}:retry`] || 0) + (fanke.counts?.[`${kind}:processing`] || 0);
  const problems = (fanke.counts?.[`${kind}:invalid`] || 0) + (fanke.counts?.[`${kind}:ignored`] || 0);
  const recentProblems = (fanke.problemFiles || fanke.recentFiles || [])
    .filter((file) => file.kind === kind && ["invalid", "retry", "ignored", "processing"].includes(file.status));
  const lastRun = fanke.assistant?.targetKind === kind ? fanke.assistant : null;
  const running = busyAction === "fanke-assistant";
  return (
    <section className="fanke-connector-card" aria-label={`凡科${label}采集器`}>
      <div className="fanke-connector-heading">
        <div><span>凡科一键增量助手</span><strong>本次只收集{label}</strong><p>系统会自动判断文件类型，只下载第一次出现、内容发生变化，或已从共享云端删除的{label}文件；云端已有且未变化的文件直接跳过。</p></div>
        <em className={helperCompatible ? "ready" : helperInstalled ? "outdated" : "neutral"}>{helperCompatible ? `助手已连接 v${helperVersion}` : helperInstalled ? `助手版本过旧 v${helperVersion || "未知"}` : "尚未安装"}</em>
      </div>
      <ol className="fanke-steps"><li>首次使用下载并安装助手</li><li>只需在浏览器中登录凡科</li><li>回到本站点击“一键增量收集”，助手会自动进入结果第一页</li></ol>
      <div className="fanke-global-date">
        <div><strong>{label}栏目收集起始日期</strong><p>只控制本栏目，早于此日期的文件不会收取。</p></div>
        <CollectionStartField schedule={schedule} onChange={onScheduleChange} label={label} />
        <SaveIndicator status={saveStatus} onRetry={onRetrySave} />
      </div>
      <div className="fanke-actions">
        <a className="secondary-action helper-download" href="/chemecar-fanke-helper.zip" download>{helperInstalled && !helperCompatible ? `下载新版助手 v${REQUIRED_FANKE_HELPER_VERSION}` : "下载采集助手"}</a>
        <button className="primary-action compact" type="button" onClick={onStart} disabled={busyAction !== null || !helperCompatible}>{running ? `正在核对${label}……` : `一键增量收集${label}`}<span>→</span></button>
      </div>
      {!helperCompatible && <p className={`fanke-helper-note ${helperInstalled ? "warning" : ""}`}>{helperInstalled ? `旧版助手不支持登录后自动进入凡科结果页和自动连接阿里邮箱。请在扩展管理中删除或停用旧版，下载并加载 v${REQUIRED_FANKE_HELPER_VERSION}，然后只需刷新本站一次；凡科和阿里邮箱无需手动刷新。` : "安装方法：下载并解压 → 在 Edge/Chrome 扩展管理中开启“开发人员模式” → 选择“加载解压缩的扩展”。只需安装一次，不需要凡科数据推送功能。"}</p>}
      {helperProgress && running && <div className="upload-progress fanke-helper-progress" role="status" aria-live="polite"><span aria-hidden="true" />{helperProgress}</div>}
      <div className="fanke-cloud-location">
        <div><strong>采集文件保存在本站共享云端</strong><p>采集不会自动下载到当前电脑。合格文件会进入对应栏目；点击“查看文件”后，可逐个“保存到本地”或“删除”。</p></div>
        <div className="fanke-library-links">
          {(["registration", "edp"] as FankeCollectibleKind[]).map((libraryKind) => <button key={libraryKind} type="button" onClick={() => onOpenLibrary(libraryKind)}><span>{libraryKind === "registration" ? "报名表" : "EDP"}</span><b>{savedCounts[libraryKind]}</b><small>查看文件</small></button>)}
        </div>
      </div>
      <div className="fanke-queue-summary"><span>{label}待处理：{pending}</span><span>需核对/日期外：{problems}</span><span>上次增量：{formatDate(lastRun?.completedAt || lastRun?.startedAt)}</span></div>
      {lastRun && <p className="fanke-last-run">上次在日期范围内共核对 {lastRun.totalRecords} 条：新增 {lastRun.newRecords} 条、变化 {lastRun.changedRecords} 条、未变化 {lastRun.unchangedRecords} 条；进入下载队列 {lastRun.queuedFiles} 个文件。未变化不代表已入库；未完成的队列会自动续跑。</p>}
      {lastRun?.lastError && <p className="fanke-error">最近问题：{lastRun.lastError}</p>}
      {recentProblems.length > 0 && <div className="fanke-problem-panel"><div className="fanke-problem-heading"><strong>未完成或需核对记录（{recentProblems.length} 条）</strong><span>可在下方框内滚动查看</span></div><ul className="fanke-problem-list">{recentProblems.map((file) => <li key={file.queueId}><strong>{file.schoolName}</strong><span>{file.filename}</span><small>{file.status === "ignored" ? "早于本栏目起始日期，未收集" : file.lastError || (file.status === "processing" ? "正在读取文件；若任务中断，超时后会自动恢复" : file.status === "retry" ? "暂时失败，等待自动重试" : "文件不符合收集规则")}</small></li>)}</ul></div>}
      {problems > 0 && <div className="fanke-problem-actions"><span>这些是失败/日期外记录，没有保存成共享文件。</span><button className="danger-action" type="button" onClick={() => onClearProblems(kind)} disabled={busyAction !== null}>{busyAction === `fanke-clear:${kind}` ? "正在清除……" : `清除本栏 ${problems} 条失败记录`}</button></div>}
    </section>
  );
}

function AliMailMediaControls({
  kind,
  label,
  schedule,
  checkpoint,
  counts,
  helperInstalled,
  helperCompatible,
  helperVersion,
  progress,
  busyAction,
  onScheduleChange,
  saveStatus,
  onRetrySave,
  onScanNow,
}: {
  kind: MediaKind;
  label: string;
  schedule: ScheduleForm;
  checkpoint: BrowserMailCheckpoint | null;
  counts: Record<string, number>;
  helperInstalled: boolean;
  helperCompatible: boolean;
  helperVersion: string;
  progress: string;
  busyAction: string | null;
  onScheduleChange: (next: ScheduleForm) => void;
  saveStatus: SaveState | "";
  onRetrySave: () => void;
  onScanNow: () => void;
}) {
  const running = busyAction === `alimail-scan:${kind}`;
  const pending = (counts[`${kind}:pending`] || 0) + (counts[`${kind}:missing`] || 0);
  const candidates = counts["unknown:candidate"] || 0;
  return <section className="alimail-media-controls" aria-label={`阿里邮箱${label}采集器`}>
    <div className="alimail-media-heading">
      <div><span>阿里邮箱自动收取</span><strong>只识别并收取{label}附件</strong><p>登录阿里邮箱和本站即可；助手会自动进入收件箱，从保存的起始日期继续扫描。</p></div>
      <em className={helperCompatible ? "ready" : helperInstalled ? "outdated" : "neutral"}>{helperCompatible ? `助手已连接 v${helperVersion}` : helperInstalled ? `请更新助手 v${helperVersion || "未知"}` : "尚未安装助手"}</em>
    </div>
    <div className="alimail-media-schedule">
      <ScheduleFields schedule={schedule} onChange={onScheduleChange} enableLabel="浏览器打开且阿里邮箱已登录时，按此频率自动扫描" />
      <div className="alimail-media-actions">
        <SaveIndicator status={saveStatus} onRetry={onRetrySave} />
        <button className="primary-action compact" type="button" onClick={onScanNow} disabled={busyAction !== null || !helperCompatible}>{running ? "正在扫描…" : "立即扫描"+label}<span>→</span></button>
      </div>
    </div>
    {!helperCompatible && <p className="fanke-helper-note warning">请下载并加载 v{REQUIRED_FANKE_HELPER_VERSION} 赛事资料采集助手。新版助手只需登录阿里邮箱，不需要手动刷新或进入收件箱。</p>}
    {progress && running && <div className="upload-progress" role="status" aria-live="polite"><span aria-hidden="true" />{progress}</div>}
    <div className="alimail-media-status">
      <div><span>最近扫描</span><strong>{formatDate(checkpoint?.lastScanAt)}</strong></div>
      <div><span>等待上传/恢复</span><strong>{pending}</strong></div>
      <div><span>压缩包待归类</span><strong>{candidates}</strong></div>
      <div><span>扫描状态</span><strong>{checkpoint?.lastError ? "需重试" : checkpoint?.lastScanAt ? "正常" : "尚未扫描"}</strong></div>
    </div>
    {checkpoint?.lastError && <p className="fanke-error">最近问题：{checkpoint.lastError}</p>}
    <details className="alimail-media-help"><summary>运行说明</summary><p>浏览器关闭后暂停；重新登录后继续。助手只读取附件，不发送、删除、移动或标记原邮件；类型或学校无法可靠判断的压缩包会留在待核对清单。</p></details>
  </section>;
}

function CollectionHelpDisclosure({
  label,
  source,
  rule,
  recollect = false,
}: {
  label: string;
  source: string;
  rule: string;
  recollect?: boolean;
}) {
  return <details className="collection-help-disclosure">
    <summary>查看{label}的收集、保存与删除说明</summary>
    <div><dl><div><dt>收集来源</dt><dd>{source}</dd></div><div><dt>保留规则</dt><dd>{rule}</dd></div><div><dt>保存位置</dt><dd>下方清单就是本站共享云端中的真实文件，不会自动存进当前电脑。点击“保存到本地”后，文件进入浏览器设置的下载文件夹。</dd></div><div><dt>删除方式</dt><dd>点击单条“删除”或先多选再批量删除；二次确认后，文件会从所有授权用户共享的资料库中移除。</dd></div>{recollect && <div><dt>删除后重收</dt><dd>从共享云端删除后，再次增量收集会按“云端是否存在”重新下载，不会因历史上收过一次而永久跳过。</dd></div>}</dl></div>
  </details>;
}

export default function CollectorDashboard() {
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [authMessage, setAuthMessage] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [founderManagementEnabled, setFounderManagementEnabled] = useState<boolean | null>(null);
  const [founderDialogOpen, setFounderDialogOpen] = useState(false);
  const [founderPassword, setFounderPassword] = useState("");
  const [newSharedPassword, setNewSharedPassword] = useState("");
  const [confirmSharedPassword, setConfirmSharedPassword] = useState("");
  const [founderMessage, setFounderMessage] = useState("");
  const [activeWorkspace, setActiveWorkspace] = useState<Workspace>("registration");
  const [registrationSchedule, setRegistrationSchedule] = useState<ScheduleForm>(defaultSchedule);
  const [edpSchedule, setEdpSchedule] = useState<ScheduleForm>(defaultSchedule);
  const [posterSchedule, setPosterSchedule] = useState<ScheduleForm>(defaultSchedule);
  const [videoSchedule, setVideoSchedule] = useState<ScheduleForm>(defaultSchedule);
  const [scheduleSaveStatus,setScheduleSaveStatus] = useState<Partial<Record<ScheduledWorkspace,SaveState>>>({});
  const scheduleSavers = useRef<Partial<Record<ScheduledWorkspace,ReturnType<typeof createAutosave<ScheduleForm>>>>>({});
  const [autoReviewError,setAutoReviewError] = useState("");
  const [master, setMaster] = useState<MasterFile | null>(null);
  const [registrations, setRegistrations] = useState<RegistrationFile[]>([]);
  const [registrationReceiptSettings, setRegistrationReceiptSettings] = useState<RegistrationReceiptSettings>(defaultRegistrationReceiptSettings);
  const [activeRegistrationReceipt, setActiveRegistrationReceipt] = useState<RegistrationFile | null>(null);
  const [edpReceiptSettings, setEdpReceiptSettings] = useState<EdpReceiptSettings>(defaultEdpReceiptSettings);
  const [activeEdpReceipt, setActiveEdpReceipt] = useState<EdpSubmission | EdpIssue | null>(null);
  const [edpSubmissions, setEdpSubmissions] = useState<EdpSubmission[]>([]);
  const [edpIssues, setEdpIssues] = useState<EdpIssue[]>([]);
  const [edpReviewSettings, setEdpReviewSettings] = useState<EdpReviewSettings>(defaultEdpReviewSettings);
  const [edpReviewJobs, setEdpReviewJobs] = useState<EdpReviewJob[]>([]);
  const [edpRuleDocuments, setEdpRuleDocuments] = useState<EdpRuleDocument[]>([]);
  const [activeEdpRuleDetail, setActiveEdpRuleDetail] = useState<EdpRuleDetail | null>(null);
  const [edpRuleYear, setEdpRuleYear] = useState("");
  const [edpRuleFile, setEdpRuleFile] = useState<File | null>(null);
  const [activeEdpReview, setActiveEdpReview] = useState<EdpReviewDetail | null>(null);
  const [selectedEdpReviewJobIds, setSelectedEdpReviewJobIds] = useState<string[]>([]);
  const [edpReviewDeleteReport, setEdpReviewDeleteReport] = useState<{
    deletedCount: number;
    failures: Array<{ schoolName: string; message: string }>;
  } | null>(null);
  const [edpReviewLoading, setEdpReviewLoading] = useState(false);
  const [edpReviewSyncSummary, setEdpReviewSyncSummary] = useState<EdpReviewSyncSummary | null>(null);
  const [posters, setPosters] = useState<MediaRecord[]>([]);
  const [videos, setVideos] = useState<MediaRecord[]>([]);
  const [fanke, setFanke] = useState<FankeDashboard>({ connected: false });
  const [fankeHelperInstalled, setFankeHelperInstalled] = useState(false);
  const [fankeHelperVersion, setFankeHelperVersion] = useState("");
  const [fankeHelperProgress, setFankeHelperProgress] = useState("");
  const [browserMailCheckpoints, setBrowserMailCheckpoints] = useState<Record<MediaKind, BrowserMailCheckpoint | null>>({ poster: null, video: null });
  const [browserMailCounts, setBrowserMailCounts] = useState<Record<string, number>>({});
  const [mailMediaProgress, setMailMediaProgress] = useState("");
  const [mailSettings, setMailSettings] = useState<MailSettings>(defaultMailSettings);
  const [mailSchedule, setMailSchedule] = useState<ScheduleForm>(defaultSchedule);
  const [mailMessages, setMailMessages] = useState<MailMessage[]>([]);
  const [mailNextCursor, setMailNextCursor] = useState<string | null>(null);
  const [mailIssues, setMailIssues] = useState<MailIssue[]>([]);
  const [mailMediaCandidates, setMailMediaCandidates] = useState<MailMediaCandidate[]>([]);
  const [mailCandidateAssignments, setMailCandidateAssignments] = useState<Record<string, string>>({});
  const [mailCandidateError, setMailCandidateError] = useState("");
  const [mailSecurityPassword, setMailSecurityPassword] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [loading, setLoading] = useState(true);
  const [dashboardConnected, setDashboardConnected] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<Record<FankeKind, string[]>>({
    registration: [],
    edp: [],
    poster: [],
    video: [],
  });

  const [masterSelection, setMasterSelection] = useState<File | null>(null);
  const [registrationFile, setRegistrationFile] = useState<File | null>(null);
  const [edpFile, setEdpFile] = useState<File | null>(null);
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [uploadStatus, setUploadStatus] = useState("");

  const masterInputRef = useRef<HTMLInputElement>(null);
  const registrationInputRef = useRef<HTMLInputElement>(null);
  const edpInputRef = useRef<HTMLInputElement>(null);
  const edpRuleInputRef = useRef<HTMLInputElement>(null);
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const founderPasswordInputRef = useRef<HTMLInputElement>(null);
  const edpReviewCloseButtonRef = useRef<HTMLButtonElement>(null);
  const edpReviewReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const fankeActiveScanRef = useRef<{ scanId: string; formId: string; kind: FankeCollectibleKind } | null>(null);
  const fankeIngestChainRef = useRef<Promise<void>>(Promise.resolve());
  const fankeQueueBusyRef = useRef(false);
  const mailActiveScanRef = useRef<{ scanId: string; kind: MediaKind } | null>(null);
  const mailAutoScanAttemptRef = useRef<Record<MediaKind, number>>({ poster: 0, video: 0 });
  const sortedRegistrations = useMemo(() => [...registrations].sort((left, right) => SCHOOL_PINYIN_COLLATOR.compare(left.schoolName, right.schoolName)), [registrations]);
  const sortedEdpSubmissions = useMemo(() => [...edpSubmissions].sort((left, right) => SCHOOL_PINYIN_COLLATOR.compare(left.schoolName, right.schoolName)), [edpSubmissions]);
  const sortedEdpIssues = useMemo(() => [...edpIssues].sort((left, right) => SCHOOL_PINYIN_COLLATOR.compare(left.schoolName, right.schoolName)), [edpIssues]);
  const latestEdpReceiptItems = useMemo(() => {
    const latest = new Map<string, EdpSubmission | EdpIssue>();
    for (const item of [...edpSubmissions, ...edpIssues]) {
      const key = item.schoolKey || item.schoolName;
      const current = latest.get(key);
      if (!current || compareSubmissionVersion(item, current) > 0) latest.set(key, item);
    }
    return [...latest.values()].sort((left, right) => SCHOOL_PINYIN_COLLATOR.compare(left.schoolName, right.schoolName));
  }, [edpIssues, edpSubmissions]);
  const sortedEdpReviewJobs = useMemo(
    () => edpReviewJobs
      .filter((job) => job.status !== "superseded")
      .sort((left, right) => SCHOOL_PINYIN_COLLATOR.compare(left.schoolName, right.schoolName)),
    [edpReviewJobs],
  );
  const edpReviewYearOptions = useMemo(() => {
    const currentYear = new Date().getFullYear();
    const years = new Set<number>();
    for (let year = currentYear - 1; year <= currentYear + 5; year += 1) years.add(year);
    if (/^20\d{2}$/u.test(edpReviewSettings.competitionYear)) years.add(Number(edpReviewSettings.competitionYear));
    return [...years].sort((left, right) => left - right).map(String);
  }, [edpReviewSettings.competitionYear]);
  const unresolvedReviewCount = activeEdpReview?.items.filter((item) => item.finalStatus === "needs_human" && item.isBlocking).length ?? 0;

  const storeMailMediaCandidates = useCallback((candidates: MailMediaCandidate[]) => {
    setMailMediaCandidates(candidates);
    setMailCandidateAssignments((current) => {
      const next: Record<string, string> = {};
      for (const candidate of candidates) {
        const id = mailCandidateId(candidate);
        if (!id) continue;
        next[id] = current[id] ?? mailCandidateSchool(candidate);
      }
      return next;
    });
  }, []);

  const loadDashboard = useCallback(async (confirmRefresh = false) => {
    try {
      const kinds: ScheduledWorkspace[] = ["registration","edp","poster","video"];
      const refreshGuards = Object.fromEntries(kinds.map(kind => [
        kind, scheduleSavers.current[kind]?.captureRead() ?? (() =>
          (scheduleSavers.current[kind]?.revision() ?? 0) === 0 && !scheduleSavers.current[kind]?.isDirty()),
      ])) as Record<ScheduledWorkspace, () => boolean>;
      const data = await requestJson<DashboardResponse>("/api/dashboard", { cache: "no-store" });
      if (refreshGuards.registration()) setRegistrationSchedule(scheduleFromApi(data.settings));
      const nextEdpSettings = data.edpSettings || defaultApiSettings;
      if (refreshGuards.edp()) setEdpSchedule(scheduleFromApi(nextEdpSettings));
      const mediaSettings = data.mediaSettings || data.media?.settings || {};
      const nextPosterSettings = mediaSettings.poster || defaultApiSettings;
      const nextVideoSettings = mediaSettings.video || defaultApiSettings;
      if (refreshGuards.poster()) setPosterSchedule(scheduleFromApi(nextPosterSettings));
      if (refreshGuards.video()) setVideoSchedule(scheduleFromApi(nextVideoSettings));
      setMaster(data.master);
      setRegistrations(data.registrations || []);
      setRegistrationReceiptSettings(data.registrationReceiptSettings || defaultRegistrationReceiptSettings);
      setEdpReceiptSettings(data.edpReceiptSettings || defaultEdpReceiptSettings);
      setEdpSubmissions(data.edpSubmissions || []);
      setEdpIssues(data.edpIssues || []);
      setFanke(data.fanke || { connected: false });
      const flatAssets = data.media?.assets || data.mediaAssets || data.assets || [];
      setPosters(flatAssets.length > 0 ? flatAssets.filter((item) => item.kind === "poster") : data.media?.posters || []);
      setVideos(flatAssets.length > 0 ? flatAssets.filter((item) => item.kind === "video") : data.media?.videos || []);
      setSelectedFiles({ registration: [], edp: [], poster: [], video: [] });
      try {
        const browserState = await requestJson<BrowserMailStateResponse>("/api/mail-browser/state", { cache: "no-store" });
        const checkpoints: Record<MediaKind, BrowserMailCheckpoint | null> = { poster: null, video: null };
        for (const checkpoint of browserState.checkpoints || []) {
          if (checkpoint.kind === "poster" || checkpoint.kind === "video") checkpoints[checkpoint.kind] = checkpoint;
        }
        setBrowserMailCheckpoints(checkpoints);
        setBrowserMailCounts(browserState.counts || {});
      } catch {
        setBrowserMailCheckpoints({ poster: null, video: null });
        setBrowserMailCounts({});
      }
      const nextMailSettings = { ...defaultMailSettings, ...(data.mail?.settings || {}) };
      setMailSettings(nextMailSettings);
      setMailSchedule(scheduleFromApi(nextMailSettings));
      setMailMessages(data.mail?.messages || []);
      setMailNextCursor(data.mail?.nextCursor || null);
      setMailIssues(data.mail?.issues || []);
      const embeddedCandidates = data.mail?.mediaCandidates || data.mail?.candidates || data.mailMediaCandidates || data.mediaCandidates || [];
      try {
        const candidateResponse = await requestJson<MailMediaCandidatesResponse | MailMediaCandidate[]>("/api/mail-media-candidates", { cache: "no-store" });
        storeMailMediaCandidates(candidatesFromResponse(candidateResponse));
        setMailCandidateError("");
      } catch (candidateError) {
        storeMailMediaCandidates(embeddedCandidates);
        setMailCandidateError(candidateError instanceof Error ? candidateError.message : "邮箱附件待确认清单读取失败。");
      }
      setDashboardConnected(true);
      if (confirmRefresh) setNotice({ kind: "success", text: "已刷新到服务器上的最新状态。" });
    } catch (error) {
      setDashboardConnected(false);
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "无法读取控制台数据，请稍后重试。" });
    } finally {
      setLoading(false);
    }
  }, [storeMailMediaCandidates]);

  const checkAuthentication = useCallback(async () => {
    setAuthState("checking");
    setLoading(true);
    try {
      const status = await requestJson<AuthStatusResponse>("/api/auth/status", { cache: "no-store" });
      if (typeof status.founderManagementEnabled === "boolean") setFounderManagementEnabled(status.founderManagementEnabled);
      if (!status.authenticated) {
        setAuthState("unauthenticated");
        setLoading(false);
        return;
      }
      setAuthMessage("");
      setAuthState("authenticated");
      await loadDashboard();
    } catch (error) {
      setAuthState("unauthenticated");
      setLoading(false);
      setAuthMessage(
        error instanceof ApiRequestError && error.status === 401
          ? "请输入访问密码后继续。"
          : error instanceof ApiRequestError && error.status === 0
            ? error.message
            : "暂时无法检查登录状态，请刷新页面后重试。",
      );
    }
  }, [loadDashboard]);

  useEffect(() => {
    const handleExpiredSession = () => {
      setAuthState("unauthenticated");
      setPassword("");
      setMailSecurityPassword("");
      setFounderDialogOpen(false);
      setActiveRegistrationReceipt(null);
      setActiveEdpReceipt(null);
      setActiveEdpReview(null);
      setSelectedEdpReviewJobIds([]);
      setFounderPassword("");
      setNewSharedPassword("");
      setConfirmSharedPassword("");
      setFounderMessage("");
      setAuthMessage("登录已过期，请重新输入密码。");
      setNotice(null);
      setBusyAction(null);
      setDashboardConnected(false);
      setLoading(false);
    };
    window.addEventListener("collector-auth-expired", handleExpiredSession);
    const initialLoad = window.setTimeout(() => { void checkAuthentication(); }, 0);
    return () => {
      window.clearTimeout(initialLoad);
      window.removeEventListener("collector-auth-expired", handleExpiredSession);
    };
  }, [checkAuthentication]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!password) {
      setAuthMessage("请输入访问密码。");
      return;
    }
    setAuthBusy(true);
    setAuthMessage("");
    try {
      const status = await requestJson<AuthStatusResponse>("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!status.authenticated) throw new ApiRequestError("登录未成功", 401);
      if (typeof status.founderManagementEnabled === "boolean") setFounderManagementEnabled(status.founderManagementEnabled);
      setPassword("");
      setMailSecurityPassword("");
      setShowPassword(false);
      setAuthState("authenticated");
      setLoading(true);
      await loadDashboard();
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401) {
        setAuthMessage("密码不正确，请重新输入。");
      } else {
        setAuthMessage(error instanceof Error ? error.message : "登录失败，请稍后重试。");
      }
    } finally {
      setAuthBusy(false);
    }
  }

  async function logout() {
    setAuthBusy(true);
    try {
      await requestJson<{ ok: true }>("/api/auth/logout", { method: "POST" });
      setAuthState("unauthenticated");
      setPassword("");
      setMailSecurityPassword("");
      setShowPassword(false);
      setFounderDialogOpen(false);
      setActiveRegistrationReceipt(null);
      setFounderPassword("");
      setNewSharedPassword("");
      setConfirmSharedPassword("");
      setFounderMessage("");
      setAuthMessage("已安全退出。再次使用时请输入访问密码。");
      setNotice(null);
      setDashboardConnected(false);
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401) {
        setAuthState("unauthenticated");
        setPassword("");
        setMailSecurityPassword("");
        setAuthMessage("登录已过期，请重新输入密码。");
        setNotice(null);
      } else {
        setNotice({ kind: "error", text: error instanceof Error ? error.message : "退出失败，请稍后重试。" });
      }
    } finally {
      setAuthBusy(false);
    }
  }

  function openFounderPasswordDialog() {
    setFounderPassword("");
    setNewSharedPassword("");
    setConfirmSharedPassword("");
    setFounderMessage("");
    setFounderDialogOpen(true);
  }

  function closeFounderPasswordDialog() {
    if (busyAction === "founder-password") return;
    setFounderDialogOpen(false);
    setFounderPassword("");
    setNewSharedPassword("");
    setConfirmSharedPassword("");
    setFounderMessage("");
  }

  async function changeSharedPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!founderPassword || !newSharedPassword || !confirmSharedPassword) {
      setFounderMessage("请完整填写三个密码输入框。");
      return;
    }
    if (newSharedPassword !== confirmSharedPassword) {
      setFounderMessage("两次输入的新共享密码不一致。");
      return;
    }
    const characterTypes = [/\p{L}/u, /\p{N}/u, /[^\p{L}\p{N}\s]/u].filter((pattern) => pattern.test(newSharedPassword)).length;
    if (newSharedPassword.length < 12 || newSharedPassword.length > 128 || characterTypes < 2) {
      setFounderMessage("新共享密码需为 12–128 个字符，并至少包含字母、数字、符号中的两类。");
      return;
    }

    setBusyAction("founder-password");
    setFounderMessage("");
    try {
      const result = await requestJson<FounderPasswordResponse>("/api/founder/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ founderPassword, newPassword: newSharedPassword }),
      });
      setFounderPassword("");
      setNewSharedPassword("");
      setConfirmSharedPassword("");
      setFounderDialogOpen(false);
      if (result.authenticated) {
        setAuthState("authenticated");
        setNotice({ kind: "success", text: "共享登录密码已更新；其他电脑和手机上的旧会话已失效，本设备已续签安全会话。" });
        await loadDashboard();
      } else {
        setAuthState("unauthenticated");
        setDashboardConnected(false);
        setNotice(null);
        setPassword("");
        setMailSecurityPassword("");
        setAuthMessage("共享登录密码已更新，所有旧会话已失效。请使用新密码重新登录。");
      }
    } catch (error) {
      setFounderPassword("");
      setFounderMessage(
        error instanceof ApiRequestError && error.status === 503
          ? "创始人密码管理尚未在服务器启用，请联系部署负责人配置后再试。"
          : error instanceof Error ? error.message : "共享登录密码更新失败，请稍后重试。",
      );
    } finally {
      setBusyAction(null);
    }
  }

  useEffect(() => {
    if (!founderDialogOpen) return;
    founderPasswordInputRef.current?.focus();
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && busyAction !== "founder-password") {
        setFounderDialogOpen(false);
        setFounderPassword("");
        setNewSharedPassword("");
        setConfirmSharedPassword("");
        setFounderMessage("");
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [busyAction, founderDialogOpen]);

  useEffect(() => {
    if (!activeRegistrationReceipt) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyAction?.startsWith("registration-receipt:")) {
        setActiveRegistrationReceipt(null);
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [activeRegistrationReceipt, busyAction]);

  useEffect(() => {
    if (!activeEdpReceipt) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && busyAction !== "alimail-edp-drafts") setActiveEdpReceipt(null);
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [activeEdpReceipt, busyAction]);

  useEffect(() => {
    if (!activeEdpReview) return;
    edpReviewCloseButtonRef.current?.focus();
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyAction?.startsWith("edp-review")) closeEdpReviewDialog();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [activeEdpReview, busyAction]);

  const registrationCount = registrations.length;
  const edpQualifiedCount = latestEdpReceiptItems.filter((item) => item.receipt.status === "qualified").length;
  const edpNeedsReviewCount = latestEdpReceiptItems.filter((item) => item.receipt.status !== "qualified").length;
  const edpReviewQueuedCount = sortedEdpReviewJobs.filter((job) => job.status === "queued" || job.status === "failed").length;
  const edpReviewProcessingCount = sortedEdpReviewJobs.filter((job) => job.status === "processing").length;
  const edpReviewNeedsHumanCount = sortedEdpReviewJobs.filter((job) => job.status === "needs_human" || job.overallStatus === "needs_human").length;
  const edpReviewCompletedCount = sortedEdpReviewJobs.filter((job) => job.status === "ready" || job.status === "completed").length;
  const edpReviewMissingCount = edpSubmissions.filter((item) => item.reviewTaskStatus === "missing").length;
  const fankeHelperCompatible = helperVersionAtLeast(fankeHelperVersion);
  const sharedFileCounts: Record<FankeKind, number> = {
    registration: registrations.length,
    edp: edpSubmissions.length,
    poster: posters.length,
    video: videos.length,
  };
  const statusLabels: Record<Workspace, string> = {
    registration: "报名资料已连接云端",
    edp: "EDP 资料已连接云端",
    edpReview: "EDP 审核资料已连接云端",
    mail: mailSettings.enabled ? "邮箱定时收取已启用" : "邮箱资料已连接云端",
    poster: "海报共享库已连接",
    video: "视频共享库已连接",
    certificate: "证书模板已连接云端",
  };
  const statusText = loading ? "正在读取共享数据" : dashboardConnected ? statusLabels[activeWorkspace] : "共享服务暂不可用";
  const statusOnline = dashboardConnected;
  const edpCheckedCount = latestEdpReceiptItems.length;
  const attachmentCount = useMemo(() => mailMessages.reduce((total, message) => total + (message.attachments?.length || 0), 0), [mailMessages]);
  const schoolOptions = useMemo(() => Array.from(new Set([
    ...registrations.map((item) => item.schoolName),
    ...edpSubmissions.map((item) => item.schoolName),
    ...posters.map((item) => item.schoolName),
    ...videos.map((item) => item.schoolName),
    ...mailMediaCandidates.map(mailCandidateSchool),
  ].map((item) => item.trim()).filter(Boolean))).sort((left, right) => left.localeCompare(right, "zh-CN")), [edpSubmissions, mailMediaCandidates, posters, registrations, videos]);
  const activeMediaKind: MediaKind = activeWorkspace === "video" ? "video" : "poster";
  const activeMediaRecords = activeMediaKind === "poster" ? posters : videos;
  const mediaLabel = activeMediaKind === "poster" ? "海报" : "视频";
  const activeMediaSchedule = activeMediaKind === "poster" ? posterSchedule : videoSchedule;

  function chooseWorkspace(next: Workspace) {
    if ((next === "poster" || next === "video") && next !== activeWorkspace) {
      setMediaFile(null);
      setUploadStatus("");
      if (mediaInputRef.current) mediaInputRef.current.value = "";
    }
    setActiveWorkspace(next);
    setNotice(null);
    if (next === "edpReview" && next !== activeWorkspace) void refreshEdpReviews({ sync: true, announce: false });
    window.setTimeout(() => document.getElementById(`${next}-workspace`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }

  async function refreshEdpReviews(options: { sync?: boolean; announce?: boolean } = {}) {
    const { sync = false, announce = false } = options;
    setEdpReviewLoading(true);
    let syncFailure: string | null = null;
    try {
      let syncSummary: EdpReviewSyncSummary | null = null;
      if (sync) {
        try {
          const response = await requestJson<{ ok: true; summary: EdpReviewSyncSummary }>("/api/edp-reviews/sync", { method: "POST" });
          syncSummary = response.summary;
          setEdpReviewSyncSummary(response.summary);
        } catch (error) {
          syncFailure = error instanceof Error ? error.message : "审核任务补建失败。";
          setEdpReviewSyncSummary(null);
        }
      }
      const [settingsResponse, jobsResponse, rulesResponse] = await Promise.all([
        requestJson<{ ok: true; settings: EdpReviewSettings }>("/api/edp-reviews/settings", { cache: "no-store" }),
        requestJson<{ ok: true; jobs: EdpReviewJob[] }>("/api/edp-reviews", { cache: "no-store" }),
        requestJson<{ ok: true; documents: EdpRuleDocument[] }>("/api/edp-rule-documents", { cache: "no-store" }),
      ]);
      setEdpReviewSettings(settingsResponse.settings);
      setEdpReviewJobs(jobsResponse.jobs || []);
      const currentReviewJobIds = new Set((jobsResponse.jobs || [])
        .filter((job) => job.status !== "superseded")
        .map((job) => job.jobId));
      setSelectedEdpReviewJobIds((current) => current.filter((jobId) => currentReviewJobIds.has(jobId)));
      const reviewSubmissionIds = new Set((jobsResponse.jobs || []).map((job) => job.submissionId));
      setEdpSubmissions((current) => current.map((item) => reviewSubmissionIds.has(item.submissionId)
        ? { ...item, reviewTaskStatus: "created" }
        : item));
      setEdpRuleDocuments(rulesResponse.documents || []);
      if (/^20\d{2}$/u.test(settingsResponse.settings.competitionYear)) {
        setEdpRuleYear((current) => /^20\d{2}$/u.test(current) ? current : settingsResponse.settings.competitionYear);
      }
      if (syncFailure) {
        setNotice({ kind: "error", text: `审核任务清单已刷新，但自动补建失败：${syncFailure}` });
      } else if (announce && syncSummary) {
        setNotice({
          kind: syncSummary.failed > 0 ? "info" : "success",
          text: `审核任务同步完成：已补建 ${syncSummary.created} 个，已有任务 ${syncSummary.existing} 个，补建失败 ${syncSummary.failed} 个。`,
        });
      } else if (announce) {
        setNotice({ kind: "success", text: "EDP 审核任务与人员设置已刷新。" });
      }
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "EDP 审核任务读取失败。" });
    } finally {
      setEdpReviewLoading(false);
    }
  }

  function applyEdpReviewDetail(detail: EdpReviewDetail) {
    setActiveEdpReview(detail);
    setEdpReviewJobs((current) => {
      const remaining = current.filter((job) => job.jobId !== detail.job.jobId);
      return [...remaining, detail.job];
    });
  }

  async function loadEdpReviewDetail(jobId: string) {
    return requestJson<EdpReviewDetail & { ok: true }>(`/api/edp-reviews/${encodeURIComponent(jobId)}`, { cache: "no-store" });
  }

  async function openEdpReview(jobId: string, trigger: HTMLButtonElement) {
    edpReviewReturnFocusRef.current = trigger;
    setBusyAction(`edp-review-open:${jobId}`);
    try {
      const detail = await loadEdpReviewDetail(jobId);
      applyEdpReviewDetail(detail);
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "EDP 审核详情读取失败。" });
    } finally {
      setBusyAction(null);
    }
  }

  function closeEdpReviewDialog() {
    setActiveEdpReview(null);
    const returnTarget = edpReviewReturnFocusRef.current;
    window.setTimeout(() => returnTarget?.focus(), 0);
  }

  async function saveEdpReviewSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusyAction("edp-review-settings");
    try {
      const result = await requestJson<{ ok: true; settings: EdpReviewSettings }>("/api/edp-reviews/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ competitionYear: edpReviewSettings.competitionYear }),
      });
      setEdpReviewSettings(result.settings);
      setNotice({ kind: "success", text: "EDP 审核年份已保存；审核人员使用系统固定信息。" });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "EDP 审核设置保存失败。" });
    } finally {
      setBusyAction(null);
    }
  }

  async function loadEdpRuleDetail(documentId: string) {
    setBusyAction(`edp-rule-open:${documentId}`);
    try {
      const detail = await requestJson<EdpRuleDetail & { ok: true }>(`/api/edp-rule-documents/${encodeURIComponent(documentId)}`, { cache: "no-store" });
      setActiveEdpRuleDetail(detail);
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "年度竞赛规则详情读取失败。" });
    } finally {
      setBusyAction(null);
    }
  }

  async function uploadEdpRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!/^20\d{2}$/u.test(edpRuleYear)) {
      setNotice({ kind: "error", text: "请先填写四位适用年份。" });
      return;
    }
    if (!edpRuleFile) {
      setNotice({ kind: "error", text: "请选择年度竞赛规则 PDF。" });
      return;
    }
    if (edpRuleFile.size > 50 * 1024 * 1024) {
      setNotice({ kind: "error", text: "年度竞赛规则 PDF 不能超过 50MB。" });
      return;
    }
    setBusyAction("edp-rule-upload");
    try {
      const form = new FormData();
      form.set("year", edpRuleYear);
      form.set("file", edpRuleFile);
      const result = await requestJson<{ ok: true; document: EdpRuleDocument }>("/api/edp-rule-documents", { method: "POST", body: form });
      setEdpRuleFile(null);
      if (edpRuleInputRef.current) edpRuleInputRef.current.value = "";
      await refreshEdpReviews();
      const detail = await requestJson<EdpRuleDetail & { ok: true }>(`/api/edp-rule-documents/${encodeURIComponent(result.document.documentId)}`, { cache: "no-store" });
      setActiveEdpRuleDetail(detail);
      setNotice({ kind: "success", text: `${result.document.filename} 已上传并完成解析，请查看候选规则事实后确认启用。` });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "年度竞赛规则上传失败。" });
    } finally {
      setBusyAction(null);
    }
  }

  async function activateEdpRule(document: EdpRuleDocument) {
    const conflictMessage = document.yearConflict
      ? `填写年份为 ${document.enteredYear}，正文检测年份为 ${document.detectedYear ?? "未知"}。确认仍将此文件作为 ${document.applicableYear} 年规则启用吗？`
      : `确认启用“${document.filename}”吗？同年度当前版本会自动转为历史归档，已有审核任务仍保持原规则版本。`;
    if (!window.confirm(conflictMessage)) return;
    setBusyAction(`edp-rule-activate:${document.documentId}`);
    try {
      await requestJson<{ ok: true; document: EdpRuleDocument }>(`/api/edp-rule-documents/${encodeURIComponent(document.documentId)}/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmYearConflict: document.yearConflict }),
      });
      await refreshEdpReviews();
      await loadEdpRuleDetail(document.documentId);
      setNotice({ kind: "success", text: `${document.applicableYear} 年竞赛规则已启用；之后新建的审核任务会锁定该版本。` });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "年度竞赛规则启用失败。" });
    } finally {
      setBusyAction(null);
    }
  }

  async function deleteEdpRule(document: EdpRuleDocument) {
    if (!window.confirm(`确定删除候选规则“${document.filename}”吗？已启用或已归档的历史规则不能删除。`)) return;
    setBusyAction(`edp-rule-delete:${document.documentId}`);
    try {
      await requestJson<{ ok: true }>(`/api/edp-rule-documents/${encodeURIComponent(document.documentId)}`, { method: "DELETE" });
      if (activeEdpRuleDetail?.document.documentId === document.documentId) setActiveEdpRuleDetail(null);
      await refreshEdpReviews();
      setNotice({ kind: "success", text: `${document.filename} 已删除。` });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "年度竞赛规则删除失败。" });
    } finally {
      setBusyAction(null);
    }
  }

  function toggleEdpReviewSelection(jobId: string, checked: boolean) {
    setSelectedEdpReviewJobIds((current) => checked
      ? current.includes(jobId) ? current : [...current, jobId]
      : current.filter((candidate) => candidate !== jobId));
  }

  async function deleteEdpReviewSubmission(job: EdpReviewJob) {
    const confirmed = window.confirm(
      `确定删除“${job.schoolName}”的当前 EDP 吗？\n\n`+
      "压缩包、该校全部审核任务和已生成的审核 Excel 都会永久删除；报名表不会被删除。此操作无法撤销。",
    );
    if (!confirmed) return;
    setBusyAction(`edp-review-delete:${job.jobId}`);
    setEdpReviewDeleteReport(null);
    setNotice({ kind: "info", text: `正在删除 ${job.schoolName} 的 EDP 与审核记录……` });
    try {
      const result = await requestJson<{ ok: true; deleted: true; schoolName: string; deletedReviewJobs: number }>(
        `/api/edp-reviews/${encodeURIComponent(job.jobId)}`,
        { method: "DELETE" },
      );
      if (activeEdpReview?.job.schoolKey === job.schoolKey) {
        setActiveEdpReview(null);
        edpReviewReturnFocusRef.current = null;
      }
      setEdpReviewJobs((current) => current.filter((item) => item.schoolKey !== job.schoolKey));
      setSelectedEdpReviewJobIds((current) => current.filter((jobId) => jobId !== job.jobId));
      await Promise.all([loadDashboard(), refreshEdpReviews()]);
      setEdpReviewDeleteReport({ deletedCount: 1, failures: [] });
      setNotice({
        kind: "success",
        text: `${result.schoolName || job.schoolName} 的 EDP 已删除，同时清理 ${result.deletedReviewJobs} 条审核任务；报名表保持不变。`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "EDP 与审核记录删除失败。";
      setEdpReviewDeleteReport({ deletedCount: 0, failures: [{ schoolName: job.schoolName, message }] });
      setNotice({ kind: "error", text: message });
    } finally {
      setBusyAction(null);
    }
  }

  async function deleteEdpReviewBatch(jobIds: string[]) {
    const requested = new Set(jobIds);
    const jobs = sortedEdpReviewJobs.filter((job) => requested.has(job.jobId));
    if (!jobs.length) return;
    const confirmed = window.confirm(
      `确定永久删除 ${jobs.length} 所学校的 EDP 与审核记录吗？\n\n`+
      "压缩包、审核任务和已生成的审核 Excel 会被清理；报名表不受影响。此操作无法撤销。",
    );
    if (!confirmed) return;
    setBusyAction("edp-review-delete-batch");
    setEdpReviewDeleteReport(null);
    const deleted: Array<{ jobId: string; schoolKey: string; schoolName: string }> = [];
    const failures: Array<{ schoolName: string; message: string }> = [];
    try {
      for (let index = 0; index < jobs.length; index += 100) {
        const group = jobs.slice(index, index + 100);
        try {
          const result = await requestJson<{
            ok: true;
            deletedCount: number;
            deleted: Array<{ jobId: string; schoolKey: string; schoolName: string }>;
            failures: Array<{ schoolName: string; message: string }>;
          }>("/api/edp-reviews/delete-batch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jobIds: group.map((job) => job.jobId) }),
          });
          deleted.push(...result.deleted);
          failures.push(...result.failures);
        } catch (error) {
          const message = error instanceof Error ? error.message : "删除请求失败。";
          failures.push(...group.map((job) => ({ schoolName: job.schoolName, message })));
        }
      }
      const removedSchoolKeys = new Set(deleted.map((item) => item.schoolKey));
      setEdpReviewJobs((current) => current.filter((job) => !removedSchoolKeys.has(job.schoolKey)));
      setSelectedEdpReviewJobIds([]);
      if (activeEdpReview && removedSchoolKeys.has(activeEdpReview.job.schoolKey)) {
        setActiveEdpReview(null);
        edpReviewReturnFocusRef.current = null;
      }
      await Promise.all([loadDashboard(), refreshEdpReviews()]);
      setEdpReviewDeleteReport({ deletedCount: deleted.length, failures });
      setNotice({
        kind: failures.length ? "error" : "success",
        text: `已删除 ${deleted.length} 所学校；失败 ${failures.length} 所。${failures.length ? "请查看审核栏中的失败明细。" : "报名表保持不变。"}`,
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function queueEdpReviews(jobIds:string[]) {
    if(!jobIds.length) {setNotice({kind:"info",text:"请先选择学校。"});return;}
    setBusyAction("edp-review-queue");
    try {
      const result=await requestJson<{accepted:string[];failures:Array<{message:string}>}>("/api/edp-reviews/enqueue",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jobIds})});
      await refreshEdpReviews();
      setNotice({kind:result.failures.length?"error":"success",text:"已加入自动审核队列 "+result.accepted.length+" 所；完成后可查看结果，再自行下载。" + result.failures.map(x=>x.message).join("；")});
    } catch(error) {setNotice({kind:"error",text:error instanceof Error?error.message:"加入审核队列失败。"});}
    finally {setBusyAction(null);}
  }

  async function downloadEdpReviews(jobIds: string[]) {
    if (!jobIds.length) {setNotice({kind:"info",text:"尚无已完成的审核结果可下载。"});return;}
    setBusyAction("edp-review-download");
    try {
      const response=await requestDownload("/api/edp-reviews/export-batch",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jobIds})});
      const succeeded=Number(response.headers.get("X-EDP-Review-Succeeded")||0);
      const failed=Number(response.headers.get("X-EDP-Review-Failed")||0);
      await saveDownloadResponse(response,jobIds.length===1?"EDP审核意见.xlsx":"EDP审核意见.zip");
      setNotice({kind:failed?"info":"success",text:"已下载 "+succeeded+" 份审核表。" + (failed?"另有 "+failed+" 项未完成或导出失败，ZIP 内含说明。":"") + "本次下载没有重新审核。"});
      await refreshEdpReviews();
    } catch(error) {setNotice({kind:"error",text:error instanceof Error?error.message:"导出失败，审核结果仍保留在站点中。"});}
    finally {setBusyAction(null);}
  }

  async function recheckEdpWithLatestRule(jobId: string) {
    setBusyAction(`edp-review-recheck:${jobId}`);
    try {
      const result = await requestJson<{ ok: true; job: EdpReviewJob }>(`/api/edp-reviews/${encodeURIComponent(jobId)}/recheck-latest`, { method: "POST" });
      await refreshEdpReviews();
      const detail = await loadEdpReviewDetail(result.job.jobId);
      applyEdpReviewDetail(detail);
      setNotice({ kind: "success", text: `${detail.job.schoolName} 已按当前启用规则另建复核任务；原审核记录保持不变。` });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "按当前年度规则建立复核任务失败。" });
    } finally {
      setBusyAction(null);
    }
  }

  function openFankeLibrary(kind: FankeCollectibleKind) {
    chooseWorkspace(kind);
    window.setTimeout(() => document.getElementById(`${kind}-files`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 120);
  }

  async function clearFankeProblemRecords(kind: FankeCollectibleKind) {
    const count = (fanke.counts?.[`${kind}:invalid`] || 0) + (fanke.counts?.[`${kind}:ignored`] || 0);
    if (count < 1) return;
    const label = kind === "registration" ? "报名表" : kind === "edp" ? "EDP" : kind === "poster" ? "海报" : "视频";
    if (!window.confirm(`确定清除${label}栏目中的 ${count} 条失败/日期外记录吗？这些记录没有对应的共享云端文件。`)) return;
    setBusyAction(`fanke-clear:${kind}`);
    try {
      const result = await requestJson<{ ok: true; deleted: number }>(`/api/fanke/problems/${kind}`, { method: "DELETE" });
      setNotice({ kind: "success", text: `已清除${label}栏目 ${result.deleted} 条失败/日期外记录；已成功保存的共享文件不受影响。` });
      await loadDashboard();
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "失败记录清除失败。" });
    } finally {
      setBusyAction(null);
    }
  }

  useEffect(() => {
    if (authState !== "authenticated") return;
    const kinds: ScheduledWorkspace[] = ["registration","edp","poster","video"];
    for (const kind of kinds) {
      scheduleSavers.current[kind] = createAutosave<ScheduleForm>(async schedule => {
        if (!Number.isInteger(schedule.frequencyValue) || schedule.frequencyValue < 1) throw new Error("频率必须是正整数。");
        const endpoint = kind === "registration" ? "/api/settings" : kind === "edp" ? "/api/edp-settings" : "/api/media-settings/" + kind;
        await requestJson(endpoint,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({
          startsAt:schedule.startDate || null,runTime:schedule.runTime,timezone:"Asia/Shanghai",
          intervalMinutes:frequencyToMinutes(schedule.frequencyValue,schedule.frequencyUnit),
          enabled: kind === "poster" || kind === "video" ? schedule.enabled : false,
        })});
      },status => setScheduleSaveStatus(current=>({...current,[kind]:status})));
    }
    const warnUnsaved = (event: BeforeUnloadEvent) => {
      if (Object.values(scheduleSavers.current).some(saver=>saver?.isDirty())) { event.preventDefault(); event.returnValue=""; }
    };
    window.addEventListener("beforeunload",warnUnsaved);
    return () => {
      window.removeEventListener("beforeunload",warnUnsaved);
      for (const saver of Object.values(scheduleSavers.current)) saver?.dispose();
      scheduleSavers.current={};
    };
  },[authState]);

  function changeSchedule(kind:ScheduledWorkspace, schedule:ScheduleForm) {
    const value={...schedule,timezone:"Asia/Shanghai"};
    const setter={registration:setRegistrationSchedule,edp:setEdpSchedule,poster:setPosterSchedule,video:setVideoSchedule}[kind];
    setter(value); scheduleSavers.current[kind]?.set(value);
  }
  async function flushSchedule(kind:ScheduledWorkspace) {
    try { await scheduleSavers.current[kind]?.flush(); return true; }
    catch(error) { setNotice({kind:"error",text:"日期或频率尚未保存，请先重试：" + (error instanceof Error ? error.message : "网络错误")}); return false; }
  }

  // One school per request; D1 preserves the queue and cron continues offline.
  useEffect(() => {
    if (authState !== "authenticated") return;
    let stopped=false; let timer: ReturnType<typeof setTimeout>;
    async function advance() {
      let delay=15000;
      try {
        const result=await requestJson<{worked:boolean;message?:string}>("/api/edp-reviews/process-next",{method:"POST"});
        if (stopped) return;
        const listing=await requestJson<{jobs:EdpReviewJob[]}>("/api/edp-reviews",{cache:"no-store"});
        if (stopped) return;
        setEdpReviewJobs(listing.jobs); setAutoReviewError(result.message || "");
        if(result.worked || listing.jobs.some(job=>job.status==="queued")) delay=2000;
      } catch(error) { if(!stopped) setAutoReviewError(error instanceof Error ? error.message : "自动审核连接暂时中断，正在重试。"); }
      if(!stopped) timer=setTimeout(()=>void advance(),delay);
    }
    timer=setTimeout(()=>void advance(),1500);
    return()=>{stopped=true;clearTimeout(timer);};
  },[authState]);

  async function startFankeAssistant(kind: FankeCollectibleKind) {
    if (!await flushSchedule(kind)) return;
    if (!fankeHelperCompatible) {
      setNotice({ kind: "info", text: fankeHelperInstalled ? `请先把采集助手更新到 v${REQUIRED_FANKE_HELPER_VERSION}，旧版已停用以避免再次误抓缩略图。` : "请先下载并安装凡科一键采集助手，然后刷新本页面。" });
      return;
    }
    if (kind === "edp" && !edpReceiptSettingsComplete(edpReceiptSettings)) {
      setNotice({ kind: "error", text: "请先在 EDP 栏目保存竞赛年份和本轮是第 1–5 次中的哪一次提交，系统才能按正确文件数量检查并生成回执。" });
      return;
    }
    const schedule = kind === "registration" ? registrationSchedule : edpSchedule;
    const label = kind === "registration" ? "报名表" : "EDP";
    if (!schedule.startDate) {
      setNotice({ kind: "error", text: `请先在${label}栏目设置并保存收集起始日期。` });
      return;
    }
    const formId = fanke.assistant?.formId || fanke.connector?.formId || "13";
    const scanId = crypto.randomUUID();
    setBusyAction("fanke-assistant");
    setFankeHelperProgress(`正在使用已有登录状态自动进入凡科表单结果第一页，只准备收集${label}……`);
    setNotice({ kind: "info", text: `${label}一键增量采集已启动。助手会自动打开或复用凡科工作页并返回第一页，其他类型文件会被跳过。` });
    try {
      const started = await requestJson<{ ok: true; startsAt: string; removedStaleQueue?: number }>("/api/fanke/assistant/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scanId, formId, targetKind: kind }),
      });
      fankeActiveScanRef.current = { scanId, formId, kind };
      fankeIngestChainRef.current = Promise.resolve();
      setFankeHelperProgress(`只核对 ${started.startsAt} 及之后的${label}，遇到更早记录后将立即停止……`);
      window.postMessage({ source: "chemecar-console", type: "FANKE_HELPER_START", requestId: scanId, formId, startsAt: started.startsAt, targetKind: kind }, window.location.origin);
    } catch (error) {
      setBusyAction(null);
      setFankeHelperProgress("");
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "无法启动凡科增量采集。" });
    }
  }

  const startAliMailMediaScan = useCallback(async (kind: MediaKind) => {
    if (!await flushSchedule(kind)) return;
    const label = kind === "poster" ? "海报" : "视频";
    const schedule = kind === "poster" ? posterSchedule : videoSchedule;
    if (!fankeHelperCompatible) {
      setNotice({ kind: "info", text: fankeHelperInstalled ? `请先把赛事资料采集助手更新到 v${REQUIRED_FANKE_HELPER_VERSION}。` : "请先下载并安装赛事资料采集助手，然后刷新本站一次。" });
      return;
    }
    if (!schedule.startDate) {
      setNotice({ kind: "error", text: `请先保存${label}栏目的收集起始日期。` });
      return;
    }
    const scanId = crypto.randomUUID();
    mailAutoScanAttemptRef.current[kind] = Date.now();
    mailActiveScanRef.current = { scanId, kind };
    setBusyAction(`alimail-scan:${kind}`);
    setMailMediaProgress(`正在连接已登录的阿里邮箱，并自动进入收件箱扫描${label}……`);
    setNotice({ kind: "info", text: `${label}扫描已启动。无需手动刷新或进入收件箱；无法可靠分类的压缩包不会误存。` });
    window.postMessage({
      source: "chemecar-console",
      type: "CHEMECAR_ALIMAIL_SCAN_START",
      requestId: scanId,
      kind,
      startsAt: schedule.startDate,
    }, window.location.origin);
  }, [fankeHelperCompatible, fankeHelperInstalled, posterSchedule, videoSchedule]);

  useEffect(() => {
    let cancelled = false;
    const ping = () => window.postMessage({ source: "chemecar-console", type: "FANKE_HELPER_PING" }, window.location.origin);
    const pingTimers = [window.setTimeout(ping, 0), window.setTimeout(ping, 700), window.setTimeout(ping, 2_000)];

    const processPendingFiles = async (kind: FankeCollectibleKind) => {
      while (fankeQueueBusyRef.current && !cancelled) await new Promise((resolve) => window.setTimeout(resolve, 250));
      fankeQueueBusyRef.current = true;
      try {
        return await drainFankeQueue(
          () => requestJson<FankeQueueResult>(`/api/fanke/collect/${kind}`, { method: "POST" }),
          () => cancelled,
          (totals) => setFankeHelperProgress(`正在下载并整理${kind === "registration" ? "报名表" : "EDP"}：已保存 ${totals.processed} 个，仍有 ${totals.remaining} 个未完成……`),
        );
      } finally {
        fankeQueueBusyRef.current = false;
      }
    };

    const failScan = async (scanId: string, message: string) => {
      try {
        await fankeIngestChainRef.current;
        await requestJson<{ ok: true }>("/api/fanke/assistant/finish", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scanId, error: message }),
        });
      } catch {
        // The original helper or ingestion error is the most useful message.
      }
      if (cancelled) return;
      fankeActiveScanRef.current = null;
      setBusyAction(null);
      setFankeHelperProgress("");
      setNotice({ kind: "error", text: message });
      await loadDashboard();
    };

    const handleMessage = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const message = event.data as Record<string, unknown> | null;
      if (!message || message.source !== "chemecar-fanke-helper" || typeof message.type !== "string") return;
      if (message.type === "FANKE_HELPER_READY") {
        setFankeHelperInstalled(true);
        setFankeHelperVersion(typeof message.version === "string" ? message.version : "");
        return;
      }
      const activeMailScan = mailActiveScanRef.current;
      if (activeMailScan && message.requestId === activeMailScan.scanId && message.type.startsWith("CHEMECAR_ALIMAIL_SCAN_")) {
        if (message.type === "CHEMECAR_ALIMAIL_SCAN_PROGRESS") {
          setMailMediaProgress(typeof message.message === "string" ? message.message : "正在读取阿里邮箱附件……");
          return;
        }
        if (message.type === "CHEMECAR_ALIMAIL_SCAN_ERROR") {
          mailActiveScanRef.current = null;
          setBusyAction(null);
          setMailMediaProgress("");
          setNotice({ kind: "error", text: typeof message.message === "string" ? message.message : "阿里邮箱媒体扫描失败，请确认已登录后重试。" });
          void loadDashboard();
          return;
        }
        if (message.type === "CHEMECAR_ALIMAIL_SCAN_DONE") {
          const scanned = typeof message.scanned === "number" ? message.scanned : 0;
          const uploaded = typeof message.uploaded === "number" ? message.uploaded : 0;
          const label = activeMailScan.kind === "poster" ? "海报" : "视频";
          mailActiveScanRef.current = null;
          setBusyAction(null);
          setMailMediaProgress("");
          void loadDashboard().then(() => setNotice({ kind: "success", text: `${label}扫描完成：读取 ${scanned} 封邮件，本次保存或恢复 ${uploaded} 个文件。` }));
          return;
        }
      }
      const active = fankeActiveScanRef.current;
      if (!active || message.requestId !== active.scanId) return;
      if (message.type === "FANKE_HELPER_PROGRESS") {
        setFankeHelperProgress(typeof message.message === "string" ? message.message : "正在核对凡科记录……");
        return;
      }
      if (message.type === "FANKE_HELPER_RECORDS" && Array.isArray(message.records)) {
        const records = message.records.slice(0, 50);
        fankeIngestChainRef.current = fankeIngestChainRef.current.then(async () => {
          await requestJson<{ ok: true }>("/api/fanke/assistant/ingest", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ scanId: active.scanId, formId: active.formId, targetKind: active.kind, records }),
          });
        });
        return;
      }
      if (message.type === "FANKE_HELPER_ERROR") {
        void failScan(active.scanId, typeof message.message === "string" ? message.message : "凡科页面读取失败。请确认凡科已经登录后重试，助手会自动重新进入结果第一页。");
        return;
      }
      if (message.type !== "FANKE_HELPER_DONE") return;
      void (async () => {
        try {
          setFankeHelperProgress("记录核对完成，正在确认增量并处理新文件……");
          await fankeIngestChainRef.current;
          const finished = await requestJson<{ ok: true; run?: { total_records?: number; new_records?: number; changed_records?: number; unchanged_records?: number; queued_files?: number } }>("/api/fanke/assistant/finish", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ scanId: active.scanId }),
          });
          const totals = await processPendingFiles(active.kind);
          if (cancelled) return;
          fankeActiveScanRef.current = null;
          setBusyAction(null);
          setFankeHelperProgress("");
          await loadDashboard();
          const run = finished.run || {};
          setNotice({
            kind: totals.invalid || totals.remaining ? "info" : "success",
            text: `${active.kind === "registration" ? "报名表" : "EDP"}${totals.remaining ? "记录核对完成，文件尚未全部处理" : "增量采集完成"}：当前栏目 ${run.total_records ?? message.records ?? 0} 条，新增 ${run.new_records ?? 0} 条、变化 ${run.changed_records ?? 0} 条、未变化 ${run.unchanged_records ?? 0} 条（未入库的继续处理）；本次成功保存 ${totals.processed} 个文件${totals.ignored ? `，日期范围外 ${totals.ignored} 个` : ""}${totals.invalid ? `，格式不合格 ${totals.invalid} 个` : ""}${totals.remaining ? `，仍有 ${totals.remaining} 个未完成（处理中 ${totals.processing} 个，等待重试 ${totals.waitingRetry} 个）；保持本站打开将自动续跑` : ""}。`,
          });
        } catch (error) {
          await failScan(active.scanId, error instanceof Error ? error.message : "凡科增量采集未能完成。");
        }
      })();
    };

    window.addEventListener("message", handleMessage);
    return () => {
      cancelled = true;
      pingTimers.forEach((timer) => window.clearTimeout(timer));
      window.removeEventListener("message", handleMessage);
    };
  }, [loadDashboard]);

  useEffect(() => {
    if (authState !== "authenticated") return;
    let cancelled = false;
    const resume = async () => {
      if (cancelled || busyAction !== null || fankeActiveScanRef.current || fankeQueueBusyRef.current) return;
      const kinds = (["registration", "edp"] as FankeCollectibleKind[]).filter((kind) =>
        ["pending", "processing", "retry"].some((status) => (fanke.counts?.[`${kind}:${status}`] || 0) > 0));
      if (!kinds.length) return;
      fankeQueueBusyRef.current = true;
      try {
        for (const kind of kinds) {
          const totals = await drainFankeQueue(
            () => requestJson<FankeQueueResult>(`/api/fanke/collect/${kind}`, { method: "POST" }),
            () => cancelled || fankeActiveScanRef.current !== null,
          );
          if (cancelled) return;
          await loadDashboard();
          if (totals.processed || totals.invalid || totals.retried || totals.ignored) {
            setNotice({ kind: totals.remaining || totals.invalid ? "info" : "success", text: `${kind === "edp" ? "EDP" : "报名表"}自动续跑：本次保存 ${totals.processed} 个，格式不合格 ${totals.invalid} 个，未完成 ${totals.remaining} 个${totals.remaining ? "；保持本站打开将继续处理" : ""}。` });
          }
        }
      } catch (error) {
        if (!cancelled) setNotice({ kind: "error", text: `文件续跑暂未完成：${error instanceof Error ? error.message : "请检查网络"}。队列已保留，将自动重试。` });
      } finally {
        fankeQueueBusyRef.current = false;
      }
    };
    const timer = window.setInterval(() => void resume(), 30_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [authState, busyAction, fanke.counts, loadDashboard]);

  useEffect(() => {
    if (authState !== "authenticated" || !dashboardConnected || loading || !fankeHelperCompatible) return;
    const runDueScan = () => {
      if (mailActiveScanRef.current || busyAction !== null) return;
      const now = new Date();
      for (const kind of ["poster", "video"] as MediaKind[]) {
        const schedule = kind === "poster" ? posterSchedule : videoSchedule;
        const checkpoint = browserMailCheckpoints[kind];
        const lastAttemptAt = mailAutoScanAttemptRef.current[kind];
        const lastScanAt = Math.max(
          checkpoint?.lastScanAt ? new Date(checkpoint.lastScanAt).getTime() : 0,
          lastAttemptAt,
        );
        if (!browserMailScanIsDue(schedule, lastScanAt > 0 ? new Date(lastScanAt).toISOString() : null, now)) continue;
        void startAliMailMediaScan(kind);
        break;
      }
    };
    runDueScan();
    const timer = window.setInterval(runDueScan, 30_000);
    return () => window.clearInterval(timer);
  }, [authState, browserMailCheckpoints, busyAction, dashboardConnected, fankeHelperCompatible, loading, posterSchedule, startAliMailMediaScan, videoSchedule]);

  async function deleteSharedRecord(endpoint: string, body: Record<string, unknown>, label: string) {
    if (!window.confirm(`确定要从所有用户共享的资料库中删除“${label}”吗？删除后无法从本站恢复。`)) return;
    setBusyAction(`delete:${endpoint}`);
    setNotice({ kind: "info", text: `正在删除 ${label}……` });
    try {
      await requestJson<{ ok: true; deleted: true }>(endpoint, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setNotice({ kind: "success", text: `${label} 已从共享资料库删除。` });
      await loadDashboard();
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : `${label} 删除失败。` });
    } finally {
      setBusyAction(null);
    }
  }

  function toggleFileSelection(kind: FankeKind, key: string, checked: boolean) {
    setSelectedFiles((current) => ({
      ...current,
      [kind]: checked
        ? Array.from(new Set([...current[kind], key]))
        : current[kind].filter((selectedKey) => selectedKey !== key),
    }));
  }

  function toggleAllFiles(kind: FankeKind, keys: string[], checked: boolean) {
    setSelectedFiles((current) => ({ ...current, [kind]: checked ? keys : [] }));
  }

  async function bulkDeleteFiles(kind: FankeKind) {
    const selected = new Set(selectedFiles[kind]);
    const label = kind === "registration" ? "报名表" : kind === "edp" ? "EDP" : kind === "poster" ? "海报" : "视频";
    const entries = kind === "registration"
      ? registrations.filter((item) => selected.has(item.schoolKey)).map((item) => ({
        key: item.schoolKey,
        endpoint: `/api/registrations/${encodeURIComponent(item.schoolKey)}`,
        body: { submittedAt: item.submittedAt, submissionId: item.submissionId },
      }))
      : kind === "edp"
        ? edpSubmissions.filter((item) => selected.has(item.schoolKey)).map((item) => ({
          key: item.schoolKey,
          endpoint: `/api/edp-submissions/${encodeURIComponent(item.schoolKey)}`,
          body: { submittedAt: item.submittedAt, submissionId: item.submissionId },
        }))
        : (kind === "poster" ? posters : videos).filter((item) => item.schoolKey && selected.has(item.schoolKey)).map((item) => ({
          key: item.schoolKey || "",
          endpoint: `/api/media/${kind}/${encodeURIComponent(item.schoolKey || "")}`,
          body: { submittedAt: item.submittedAt, submissionId: item.submissionId },
        }));
    if (entries.length === 0) return;
    if (!window.confirm(`确定从所有用户共享的资料库中删除选中的 ${entries.length} 份${label}吗？删除后无法从本站恢复。`)) return;
    setBusyAction(`bulk-delete:${kind}`);
    setNotice({ kind: "info", text: `正在批量删除 ${entries.length} 份${label}……` });
    const deleted: string[] = [];
    const failed: string[] = [];
    for (const entry of entries) {
      try {
        await requestJson<{ ok: true }>(entry.endpoint, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(entry.body),
        });
        deleted.push(entry.key);
      } catch {
        failed.push(entry.key);
      }
    }
    setSelectedFiles((current) => ({
      ...current,
      [kind]: current[kind].filter((key) => failed.includes(key)),
    }));
    await loadDashboard();
    setBusyAction(null);
    setNotice(failed.length > 0
      ? { kind: "error", text: `已删除 ${deleted.length} 份${label}，另有 ${failed.length} 份删除失败；失败项仍保留在清单中，请刷新后重试。` }
      : { kind: "success", text: `已从共享资料库批量删除 ${deleted.length} 份${label}。` });
  }

  async function uploadMaster(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!masterSelection) { setNotice({ kind: "error", text: "请选择一份 .xlsx 统计表。" }); return; }
    const formData = new FormData();
    formData.append("file", masterSelection);
    setBusyAction("master");
    setNotice({ kind: "info", text: master ? "正在替换当前统计表……" : "正在上传唯一统计表……" });
    try {
      const data = await requestJson<{ ok: true; master: MasterFile }>("/api/master", { method: "POST", body: formData });
      setMaster(data.master);
      setMasterSelection(null);
      if (masterInputRef.current) masterInputRef.current.value = "";
      setNotice({ kind: "success", text: "统计表已保存。它将作为后续自动整理的唯一主表，不会另建副本。" });
      await loadDashboard();
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "统计表上传失败。" });
    } finally {
      setBusyAction(null);
    }
  }

  async function uploadRegistration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!registrationFile) { setNotice({ kind: "error", text: "请选择 .xlsx 报名表。" }); return; }
    const formData = new FormData();
    formData.append("file", registrationFile);
    setBusyAction("registration-upload");
    setNotice({ kind: "info", text: `正在从文件名识别学校并补录 ${registrationFile.name}……` });
    try {
      const data = await requestJson<{ ok: true; accepted: boolean; registration: RegistrationFile; masterSync?: { status: "updated" | "not-configured" | "not-qualified" | "failed"; message: string } }>("/api/registrations", { method: "POST", body: formData });
      if (data.accepted) {
        setRegistrationFile(null);
        if (registrationInputRef.current) registrationInputRef.current.value = "";
        setNotice({
          kind: data.masterSync?.status === "failed" || data.masterSync?.status === "not-qualified" ? "info" : "success",
          text: `${data.registration.schoolName} 的最新报名表已保存，旧版已被覆盖。${data.masterSync?.message ? ` ${data.masterSync.message}` : ""}`,
        });
      } else {
        setNotice({ kind: "info", text: "这份文件不比现有版本新，系统已保留该校当前最新版。" });
      }
      await loadDashboard();
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "报名表补录失败。" });
    } finally {
      setBusyAction(null);
    }
  }

  async function saveRegistrationReceiptSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusyAction("registration-receipt-settings");
    setNotice({ kind: "info", text: "正在保存报名回执中的竞赛年份和 QQ 群号……" });
    try {
      const data = await requestJson<{ ok: true; settings: RegistrationReceiptSettings; message?: string }>("/api/registration-receipt-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          competitionYear: registrationReceiptSettings.competitionYear,
          qqGroup: registrationReceiptSettings.qqGroup,
        }),
      });
      setRegistrationReceiptSettings(data.settings);
      setActiveRegistrationReceipt(null);
      await loadDashboard();
      setNotice({ kind: "success", text: data.message || "报名回执设置已保存。" });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "报名回执设置保存失败。" });
    } finally {
      setBusyAction(null);
    }
  }

  async function saveEdpReceiptSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusyAction("edp-receipt-settings");
    setNotice({ kind: "info", text: "正在保存 EDP 回执年份和提交次数……" });
    try {
      const data = await requestJson<{ ok: true; settings: EdpReceiptSettings; message?: string }>("/api/edp-receipt-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          competitionYear: edpReceiptSettings.competitionYear,
          submissionRound: edpReceiptSettings.submissionRound,
        }),
      });
      setEdpReceiptSettings(data.settings);
      setActiveEdpReceipt(null);
      await loadDashboard();
      setNotice({ kind: "success", text: data.message || "EDP 回执设置已保存。" });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "EDP 回执设置保存失败。" });
    } finally {
      setBusyAction(null);
    }
  }

  async function refreshRegistrationReceipt(item: RegistrationFile) {
    setBusyAction(`registration-receipt:${item.schoolKey}`);
    setNotice({ kind: "info", text: `正在检查 ${item.schoolName} 报名表并生成回执……` });
    try {
      const data = await requestJson<{ ok: true; registration: RegistrationFile; message?: string }>(`/api/registrations/${encodeURIComponent(item.schoolKey)}/receipt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ submittedAt: item.submittedAt, submissionId: item.submissionId }),
      });
      setRegistrations((current) => current.map((entry) => entry.schoolKey === item.schoolKey ? data.registration : entry));
      setActiveRegistrationReceipt(data.registration);
      setNotice({ kind: data.registration.receipt.status === "qualified" ? "success" : "info", text: data.message || "报名回执已生成。" });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "报名回执生成失败。" });
    } finally {
      setBusyAction(null);
    }
  }

  async function copyRegistrationReceipt(receipt: RegistrationReceipt) {
    if (!receipt.body) return;
    try {
      await navigator.clipboard.writeText(receipt.body);
    } catch {
      const field = document.createElement("textarea");
      field.value = receipt.body;
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.appendChild(field);
      field.select();
      const copied = document.execCommand("copy");
      field.remove();
      if (!copied) throw new Error("copy failed");
    }
    setNotice({ kind: "success", text: "邮件正文已复制，可以粘贴到阿里邮箱中发送。" });
  }

  async function copyEdpReceipt(receipt: EdpReceipt) {
    if (!receipt.body) return;
    try {
      await navigator.clipboard.writeText(receipt.body);
    } catch {
      const field = document.createElement("textarea");
      field.value = receipt.body;
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.appendChild(field);
      field.select();
      const copied = document.execCommand("copy");
      field.remove();
      if (!copied) throw new Error("copy failed");
    }
    setNotice({ kind: "success", text: "EDP 回执正文已复制，可以粘贴到阿里邮箱中发送。" });
  }

  function requestAlibabaDraftBatch(drafts: AlibabaDraft[]): Promise<{ created: number; saved: number; leftOpen: number }> {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timeout = window.setTimeout(() => {
        window.removeEventListener("message", handleResult);
        reject(new Error("等待阿里邮箱草稿写入超时。请确认已经登录阿里邮箱后重试；助手会自动打开写信页，不需要手动刷新。"));
      }, 120_000);
      function handleResult(event: MessageEvent) {
        if (event.source !== window || event.origin !== window.location.origin) return;
        const message = event.data as Record<string, unknown> | null;
        if (!message || message.source !== "chemecar-fanke-helper" || message.type !== "FANKE_HELPER_ALIMAIL_RESULT" || message.requestId !== requestId) return;
        window.clearTimeout(timeout);
        window.removeEventListener("message", handleResult);
        if (message.ok !== true) {
          reject(new Error(typeof message.message === "string" ? message.message : "阿里邮箱草稿写入失败。"));
          return;
        }
        resolve({
          created: typeof message.created === "number" ? message.created : drafts.length,
          saved: typeof message.saved === "number" ? message.saved : 0,
          leftOpen: typeof message.leftOpen === "number" ? message.leftOpen : 0,
        });
      }
      window.addEventListener("message", handleResult);
      window.postMessage({
        source: "chemecar-console",
        type: "FANKE_HELPER_ALIMAIL_DRAFTS",
        requestId,
        drafts,
      }, window.location.origin);
    });
  }

  async function writeRegistrationDrafts(items: RegistrationFile[], scopeLabel: string) {
    if (!fankeHelperCompatible) {
      setNotice({ kind: "error", text: `请先下载并启用采集助手 v${REQUIRED_FANKE_HELPER_VERSION}，再刷新本站一次。阿里邮箱只需登录，不需要手动刷新或打开写信页。` });
      return;
    }
    const eligible = items.filter((item) => item.receipt.status !== "needs_review"
      && isValidReceiptEmail(item.receipt.recipientEmail)
      && Boolean(item.receipt.subject)
      && Boolean(item.receipt.body));
    const omitted = items.length - eligible.length;
    if (!eligible.length) {
      const settingsMissing = items.some((item) => item.receipt.status === "qualified" && !item.receipt.settingsComplete);
      setNotice({
        kind: "error",
        text: settingsMissing
          ? "报名检查已通过，但成功回执尚未生成。请先填写并保存竞赛年份和交流 QQ 群号。"
          : "所选报名表没有可写入的完整回执；请先生成回执并确认报名表填写了格式正确的联系邮箱。",
      });
      return;
    }
    if (eligible.length > 1 && !window.confirm(`将为${scopeLabel}创建 ${eligible.length} 封阿里邮箱草稿，助手不会自动发送。是否继续？`)) return;
    setBusyAction("alimail-drafts");
    setNotice({ kind: "info", text: `正在把 ${eligible.length} 封回执分别写入阿里邮箱的收件人、主题和正文……` });
    try {
      let created = 0;
      let leftOpen = 0;
      for (let offset = 0; offset < eligible.length; offset += ALIMAIL_DRAFT_BATCH_SIZE) {
        const currentBatch = eligible.slice(offset, offset + ALIMAIL_DRAFT_BATCH_SIZE);
        const batch = currentBatch.map((item) => ({
          schoolName: item.schoolName,
          recipient: normalizeReceiptEmail(item.receipt.recipientEmail),
          subject: item.receipt.subject,
          body: item.receipt.body,
        }));
        try {
          const result = await requestAlibabaDraftBatch(batch);
          created += result.created;
          leftOpen += result.leftOpen;
          setNotice({ kind: "info", text: `已保存 ${created}/${eligible.length} 封草稿；刚完成至：${currentBatch.at(-1)?.schoolName || "当前批次"}。助手正在自动打开下一封，请保持两个标签页打开……` });
          if (offset + currentBatch.length < eligible.length) await new Promise((resolve) => window.setTimeout(resolve, 900));
        } catch (error) {
          const reason = error instanceof Error ? error.message : "阿里邮箱草稿写入失败。";
          throw new Error(`${reason}${created ? ` 此前已成功保存 ${created} 封。` : ""}`);
        }
      }
      setNotice({
        kind: "success",
        text: `${created} 封回执已分别写入阿里邮箱${leftOpen ? "写信窗口" : "草稿箱"}，没有自动发送，请逐封检查后再发送。${omitted ? `另有 ${omitted} 份因回执未生成、缺少收件邮箱或邮箱格式不正确而自动跳过。` : ""}`,
      });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "阿里邮箱草稿写入失败。" });
    } finally {
      setBusyAction(null);
    }
  }

  async function writeEdpDrafts(items: Array<EdpSubmission | EdpIssue>, scopeLabel: string) {
    if (!fankeHelperCompatible) {
      setNotice({ kind: "error", text: `请先下载并启用采集助手 v${REQUIRED_FANKE_HELPER_VERSION}，再刷新本站一次。阿里邮箱只需登录，不需要手动刷新或打开写信页。` });
      return;
    }
    const eligible = items.filter((item) => item.receipt.status !== "needs_configuration"
      && isValidReceiptEmail(item.receipt.recipientEmail)
      && Boolean(item.receipt.subject)
      && Boolean(item.receipt.body));
    const omitted = items.length - eligible.length;
    if (!eligible.length) {
      const settingsMissing = items.some((item) => !item.receipt.settingsComplete);
      setNotice({
        kind: "error",
        text: settingsMissing
          ? "EDP 回执尚未生成。请先保存竞赛年份和本轮提交次数。"
          : "所选 EDP 记录没有可写入的完整回执；请确认对应报名表中填写了格式正确的团队联系邮箱。",
      });
      return;
    }
    if (eligible.length > 1 && !window.confirm(`将为${scopeLabel}创建 ${eligible.length} 封 EDP 回执草稿，助手不会自动发送。是否继续？`)) return;
    setBusyAction("alimail-edp-drafts");
    setNotice({ kind: "info", text: `正在把 ${eligible.length} 封 EDP 回执分别写入阿里邮箱……` });
    try {
      let created = 0;
      let leftOpen = 0;
      for (let offset = 0; offset < eligible.length; offset += ALIMAIL_DRAFT_BATCH_SIZE) {
        const currentBatch = eligible.slice(offset, offset + ALIMAIL_DRAFT_BATCH_SIZE);
        const batch = currentBatch.map((item) => ({
          schoolName: item.schoolName,
          recipient: normalizeReceiptEmail(item.receipt.recipientEmail),
          subject: item.receipt.subject,
          body: item.receipt.body,
        }));
        try {
          const result = await requestAlibabaDraftBatch(batch);
          created += result.created;
          leftOpen += result.leftOpen;
          setNotice({ kind: "info", text: `已保存 ${created}/${eligible.length} 封 EDP 回执草稿；刚完成至：${currentBatch.at(-1)?.schoolName || "当前批次"}。` });
          if (offset + currentBatch.length < eligible.length) await new Promise((resolve) => window.setTimeout(resolve, 900));
        } catch (error) {
          const reason = error instanceof Error ? error.message : "EDP 回执草稿写入失败。";
          throw new Error(`${reason}${created ? ` 此前已成功保存 ${created} 封。` : ""}`);
        }
      }
      setNotice({
        kind: "success",
        text: `${created} 封 EDP 回执已分别写入阿里邮箱${leftOpen ? "写信窗口" : "草稿箱"}，没有自动发送。${omitted ? `另有 ${omitted} 份因设置未完成、缺少邮箱或邮箱格式不正确而自动跳过。` : ""}`,
      });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "EDP 回执草稿写入失败。" });
    } finally {
      setBusyAction(null);
    }
  }

  async function uploadEdp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!edpReceiptSettingsComplete(edpReceiptSettings)) {
      setNotice({ kind: "error", text: "请先保存 EDP 回执的竞赛年份和提交次数，再上传并检查压缩包。" });
      return;
    }
    if (!edpFile) { setNotice({ kind: "error", text: "请选择 ZIP、7z 或 RAR 压缩包。" }); return; }
    const formData = new FormData();
    formData.append("file", edpFile);
    setBusyAction("edp-upload");
    setNotice({ kind: "info", text: `正在从文件名识别学校并检查 ${edpFile.name}……` });
    try {
      const data = await requestJson<{ ok: true; accepted?: boolean; qualified?: boolean; submission?: EdpSubmission; issue?: EdpIssue; reason?: string }>("/api/edp-submissions", { method: "POST", body: formData });
      const schoolName = data.submission?.schoolName || data.issue?.schoolName || "该学校";
      if (data.accepted === false && data.qualified === false) {
        setNotice({ kind: "info", text: `${schoolName} 的压缩包未通过检查，文件未收集；问题原因已加入不合格清单。` });
      } else if (data.accepted === false) {
        setNotice({ kind: "info", text: "这份压缩包不比现有版本新，系统已保留该校当前有效记录。" });
      } else {
        setEdpFile(null);
        if (edpInputRef.current) edpInputRef.current.value = "";
        setNotice({
          kind: data.qualified === false || Boolean(data.issue) ? "info" : "success",
          text: data.qualified === false || data.issue
            ? `${schoolName} 的压缩包未通过检查，文件未收集；请查看不合格清单。`
            : `${schoolName} 的 EDP 压缩包已通过检查并加入合格清单。`,
        });
      }
      await loadDashboard();
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "EDP 压缩包补录失败。" });
    } finally {
      setBusyAction(null);
    }
  }

  async function uploadMedia(kind: MediaKind, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!mediaFile) { setNotice({ kind: "error", text: "请选择要补录的文件。" }); return; }

    const extension = mediaFile.name.split(".").pop()?.toLocaleLowerCase("en-US") || "";
    const archiveExtensions = ["zip", "7z", "rar"];
    const allowed = kind === "poster"
      ? ["ai", "jpg", "jpeg", ...archiveExtensions].includes(extension)
      : ["mp4", ...archiveExtensions].includes(extension);
    if (!allowed) {
      setNotice({ kind: "error", text: kind === "poster" ? "海报仅支持 .ai、.jpg、.jpeg、.zip、.7z 或 .rar 格式。" : "视频仅支持 .mp4、.zip、.7z 或 .rar 格式。" });
      return;
    }
    if (mediaFile.size > 200 * 1024 * 1024) {
      setNotice({ kind: "error", text: "海报或视频文件不能超过 200MB。" });
      return;
    }

    setBusyAction(`${kind}-upload`);
    setUploadStatus(`正在创建 ${mediaFile.name} 的安全分片上传……`);
    setNotice({ kind: "info", text: `正在从文件名识别学校并上传${kind === "poster" ? "海报" : "视频"}……` });
    let uploadSessionId = "";
    try {
      const created = await requestJson<{
        ok: true;
        accepted?: boolean;
        sessionId?: string;
        partSize?: number;
        partCount?: number;
        asset?: MediaRecord;
        schoolName?: string;
      }>(`/api/media/${kind}/multipart/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: mediaFile.name,
          totalSize: mediaFile.size,
        }),
      });
      if (created.accepted === false) {
        setNotice({ kind: "info", text: "这份文件不比共享库中的现有版本新，系统已保留该校当前最新版。" });
      } else {
        if (!created.sessionId || !created.partSize || !created.partCount) {
          throw new ApiRequestError("服务器未返回完整的分片上传参数，请重试。", 500);
        }
        uploadSessionId = created.sessionId;
        const parts: Array<{ partNumber: number; etag: string }> = [];
        for (let partNumber = 1; partNumber <= created.partCount; partNumber += 1) {
          const start = (partNumber - 1) * created.partSize;
          const chunk = mediaFile.slice(start, Math.min(start + created.partSize, mediaFile.size));
          const percent = Math.round((partNumber - 1) / created.partCount * 100);
          setUploadStatus(`正在分片上传 ${mediaFile.name}：${percent}%（${partNumber}/${created.partCount}）`);
          const uploaded = await requestJson<{ ok: true; partNumber: number; etag: string }>(
            `/api/media/${kind}/multipart/${encodeURIComponent(created.sessionId)}/parts/${partNumber}`,
            { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: chunk },
          );
          parts.push({ partNumber: uploaded.partNumber, etag: uploaded.etag });
        }
        setUploadStatus(`文件分片已上传 100%，正在云端合并并更新${kind === "poster" ? "海报" : "视频"}清单……`);
        const data = await requestJson<{ ok: true; accepted?: boolean; asset?: MediaRecord }>(
          `/api/media/${kind}/multipart/${encodeURIComponent(created.sessionId)}/complete`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ parts }),
          },
        );
        uploadSessionId = "";
        const record = data.asset;
        if (data.accepted === false) {
          setNotice({ kind: "info", text: "合并期间收到了该校更新版本，系统已保留共享库中的最新版。" });
          await loadDashboard();
          return;
        }
        setMediaFile(null);
        if (mediaInputRef.current) mediaInputRef.current.value = "";
        setNotice({ kind: "success", text: `${record?.schoolName || created.schoolName || "识别出的学校"} 的最新${kind === "poster" ? "海报" : "视频"}已保存到共享云端，旧版已被覆盖。` });
      }
      await loadDashboard();
    } catch (error) {
      if (uploadSessionId) {
        await fetch(`/api/media/${kind}/multipart/${encodeURIComponent(uploadSessionId)}`, {
          method: "DELETE",
          credentials: "same-origin",
        }).catch(() => undefined);
      }
      setNotice({ kind: "error", text: error instanceof Error ? error.message : `${kind === "poster" ? "海报" : "视频"}上传失败。` });
    } finally {
      setBusyAction(null);
      setUploadStatus("");
    }
  }

  async function saveMailSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = mailSettings.email.trim();
    const host = mailSettings.imapHost.trim();
    if (!email || !host || !Number.isInteger(mailSettings.imapPort) || mailSettings.imapPort < 1 || mailSettings.imapPort > 65535) {
      setNotice({ kind: "error", text: "请填写有效的阿里邮箱账号、IMAP 地址和端口。" });
      return;
    }
    if (mailSchedule.enabled && !mailSchedule.startDate) {
      setNotice({ kind: "error", text: "启用定时收取前，请先设置开始日期。" });
      return;
    }
    if (mailSchedule.enabled && !mailSettings.credentialConfigured && !mailSecurityPassword) {
      setNotice({ kind: "error", text: "首次启用邮箱收取时，请填写阿里邮箱安全密码。" });
      return;
    }

    setBusyAction("mail-settings");
    setNotice({ kind: "info", text: "正在安全保存邮箱与定时收取设置……" });
    try {
      const payload = {
        email,
        imapHost: host,
        imapPort: mailSettings.imapPort,
        enabled: mailSchedule.enabled,
        startsAt: mailSchedule.startDate || null,
        runTime: mailSchedule.runTime,
        timezone: mailSchedule.timezone,
        intervalMinutes: frequencyToMinutes(mailSchedule.frequencyValue, mailSchedule.frequencyUnit),
        ...(mailSecurityPassword ? { securityPassword: mailSecurityPassword } : {}),
      };
      const data = await requestJson<{ ok: true; settings?: MailSettings; mailSettings?: MailSettings }>("/api/mail-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const returned = { ...defaultMailSettings, ...mailSettings, ...(data.settings || data.mailSettings || {}), email, imapHost: host };
      setMailSettings(returned);
      setMailSchedule(scheduleFromApi(returned));
      setMailSecurityPassword("");
      setNotice({ kind: "success", text: `邮箱设置已保存到共享服务器；${mailSchedule.enabled ? `将按${frequencySummary(mailSchedule)}收取` : "定时收取目前关闭"}。` });
      await loadDashboard();
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "邮箱设置保存失败。" });
    } finally {
      setBusyAction(null);
    }
  }

  async function testMailConnection() {
    setBusyAction("mail-test");
    setNotice({ kind: "info", text: "正在测试阿里邮箱 IMAP 连接……" });
    try {
      const data = await requestJson<{ ok: true; message?: string }>("/api/mail-test", { method: "POST" });
      setNotice({ kind: "success", text: data.message || "连接测试成功，服务器可以访问该邮箱。" });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "邮箱连接测试失败。" });
    } finally {
      setBusyAction(null);
    }
  }

  async function syncMailNow() {
    setBusyAction("mail-sync");
    setNotice({ kind: "info", text: "正在从阿里邮箱收取最新邮件与附件……" });
    try {
      const data = await requestJson<{ ok: true; message?: string; collected?: number; received?: number }>("/api/mail-sync", { method: "POST" });
      await loadDashboard();
      const count = data.collected ?? data.received;
      setNotice({ kind: "success", text: data.message || (typeof count === "number" ? `收取完成，本次处理 ${count} 封邮件。` : "收取完成，邮件与附件清单已更新。") });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "立即收取失败。" });
    } finally {
      setBusyAction(null);
    }
  }

  async function loadMoreMailMessages() {
    if (!mailNextCursor || busyAction !== null) return;
    setBusyAction("mail-load-more");
    try {
      const query = new URLSearchParams({ cursor: mailNextCursor, limit: "50" });
      const data = await requestJson<{ ok: true; messages?: MailMessage[]; nextCursor?: string | null }>(`/api/mail-messages?${query.toString()}`, { cache: "no-store" });
      const incoming = data.messages || [];
      setMailMessages((current) => appendUniqueMailMessages(current, incoming));
      setMailNextCursor(data.nextCursor || null);
      if (incoming.length === 0 && !data.nextCursor) setNotice({ kind: "info", text: "邮件历史已经全部加载。" });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "更多邮件加载失败，请稍后重试。" });
    } finally {
      setBusyAction(null);
    }
  }

  async function assignMailMediaCandidate(candidate: MailMediaCandidate, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = mailCandidateId(candidate);
    const schoolName = (mailCandidateAssignments[id] || "").trim();
    if (!id) {
      setNotice({ kind: "error", text: "这条待确认附件缺少编号，请刷新后重试。" });
      return;
    }
    if (!schoolName) {
      setNotice({ kind: "error", text: "请输入或选择该附件所属学校。" });
      return;
    }

    setBusyAction(`mail-candidate:${id}`);
    setNotice({ kind: "info", text: `正在将 ${mailCandidateFilename(candidate)} 归入 ${schoolName}……` });
    try {
      const result = await requestJson<{ ok: true; message?: string; schoolName?: string; asset?: MediaRecord }>(`/api/mail-media-candidates/${encodeURIComponent(id)}/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schoolName }),
      });
      setNotice({ kind: "success", text: result.message || `${mailCandidateFilename(candidate)} 已归入 ${result.schoolName || result.asset?.schoolName || schoolName}，资料库已更新。` });
      await loadDashboard();
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "附件归属确认失败，请稍后重试。" });
    } finally {
      setBusyAction(null);
    }
  }

  const founderPasswordDialog = founderDialogOpen ? (
    <div className="founder-dialog-backdrop">
      <section className="founder-dialog" role="dialog" aria-modal="true" aria-labelledby="founder-dialog-title" aria-describedby="founder-dialog-description">
        <div className="founder-dialog-heading">
          <div><span>创始人安全设置</span><h2 id="founder-dialog-title">设置共享登录密码</h2></div>
          <button type="button" onClick={closeFounderPasswordDialog} disabled={busyAction === "founder-password"} aria-label="关闭创始人密码设置">×</button>
        </div>
        <p id="founder-dialog-description">更新后，所有电脑和手机仍然只使用同一个共享登录密码。其他设备上的旧会话会立即失效，本页面不会保存或回显任何密码。</p>
        <div className="founder-password-rule"><strong>新密码规则</strong><span>12–128 个字符，至少包含字母、数字、符号中的两类。</span></div>
        <form className="founder-password-form" onSubmit={changeSharedPassword} autoComplete="off">
          <label>创始人管理密码<input ref={founderPasswordInputRef} type="password" required maxLength={256} autoComplete="off" value={founderPassword} onChange={(event) => setFounderPassword(event.target.value)} /></label>
          <label>新共享登录密码<input type="password" required minLength={12} maxLength={128} autoComplete="new-password" value={newSharedPassword} onChange={(event) => setNewSharedPassword(event.target.value)} /></label>
          <label>确认新共享登录密码<input type="password" required minLength={12} maxLength={128} autoComplete="new-password" value={confirmSharedPassword} onChange={(event) => setConfirmSharedPassword(event.target.value)} /></label>
          {founderMessage && <div className="founder-form-message" role="alert"><span>!</span>{founderMessage}</div>}
          <div className="founder-dialog-actions"><button className="ghost-action" type="button" onClick={closeFounderPasswordDialog} disabled={busyAction === "founder-password"}>取消</button><button className="primary-action" type="submit" disabled={busyAction !== null}>{busyAction === "founder-password" ? "正在安全更新……" : "更新所有设备的共享密码"}<span>→</span></button></div>
        </form>
      </section>
    </div>
  ) : null;

  const registrationReceiptDialog = activeRegistrationReceipt ? (
    <div className="receipt-dialog-backdrop">
      <section className="receipt-dialog" role="dialog" aria-modal="true" aria-labelledby="receipt-dialog-title" aria-describedby="receipt-dialog-description">
        <div className="receipt-dialog-heading">
          <div><span>报名表 · 阿里邮箱回执</span><h2 id="receipt-dialog-title">{activeRegistrationReceipt.schoolName}报名回执</h2></div>
          <button type="button" onClick={() => setActiveRegistrationReceipt(null)} disabled={busyAction === `registration-receipt:${activeRegistrationReceipt.schoolKey}`} aria-label="关闭报名回执">×</button>
        </div>
        {activeRegistrationReceipt.receipt.status === "needs_review" ? (
          <div className="receipt-needs-review" id="receipt-dialog-description">
            <strong>{activeRegistrationReceipt.receipt.requiresReassessment ? "旧版检查结果已停用，需要重新核对" : "这份报名表尚未生成回执"}</strong>
            <p>{activeRegistrationReceipt.receipt.requiresReassessment ? "系统检测到旧版曾把 Excel 最后一行残值误判为人员。点击下方按钮后会重新读取云端原文件，并按有效信息生成正确回执。" : "它可能是在回执功能上线前收集的。点击下方按钮后，系统会读取云端报名表，核对指导教师、学生人数及表1和表2必填项。"}</p>
            <button className="primary-action" type="button" onClick={() => void refreshRegistrationReceipt(activeRegistrationReceipt)} disabled={busyAction !== null}>{busyAction === `registration-receipt:${activeRegistrationReceipt.schoolKey}` ? "正在检查报名表……" : "立即重新检查并生成回执"}<span>→</span></button>
          </div>
        ) : (
          <>
            <div className={`receipt-assessment ${activeRegistrationReceipt.receipt.status}`} id="receipt-dialog-description">
              <strong>{activeRegistrationReceipt.receipt.status === "qualified" ? "报名检查通过" : "报名检查未通过"}</strong>
              <span>指导教师 {activeRegistrationReceipt.receipt.teacherCount} 人 · 学生 {activeRegistrationReceipt.receipt.studentCount} 人</span>
              <button className="receipt-recheck-action" type="button" onClick={() => void refreshRegistrationReceipt(activeRegistrationReceipt)} disabled={busyAction !== null}>{busyAction === `registration-receipt:${activeRegistrationReceipt.schoolKey}` ? "正在重新检查……" : "重新检查当前文件"}</button>
            </div>
            {activeRegistrationReceipt.receipt.reasons.length > 0 && <div className="receipt-reasons"><strong>需要修改的内容</strong><ul>{activeRegistrationReceipt.receipt.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></div>}
            {activeRegistrationReceipt.receipt.status === "qualified" && !activeRegistrationReceipt.receipt.settingsComplete ? (
              <div className="receipt-settings-required">
                <strong>成功回执还差两项赛事设置</strong>
                <p>请关闭本窗口，在报名表栏目填写并保存竞赛年份和交流 QQ 群号。保存后重新查看，系统会自动生成不含占位文字的完整成功回执。</p>
                <button className="primary-action" type="button" onClick={() => setActiveRegistrationReceipt(null)}>返回填写回执设置<span>→</span></button>
              </div>
            ) : (
              <>
                <dl className="receipt-mail-meta"><div><dt>收件人</dt><dd>{activeRegistrationReceipt.receipt.recipientEmail || "报名表未填写团队联系邮箱"}</dd></div><div><dt>邮件主题</dt><dd>{activeRegistrationReceipt.receipt.subject}</dd></div></dl>
                <pre className="receipt-body">{activeRegistrationReceipt.receipt.body}</pre>
                <p className="receipt-send-note">助手只会把收件人、主题和正文分别写入阿里邮箱草稿，绝不会自动发送。只需提前登录阿里邮箱，助手会自动打开写信页；写入后请逐封检查。</p>
                <div className="receipt-dialog-actions"><button className="ghost-action" type="button" onClick={() => setActiveRegistrationReceipt(null)}>关闭</button><button className="secondary-action" type="button" onClick={() => void copyRegistrationReceipt(activeRegistrationReceipt.receipt)}>复制邮件正文</button><a className="secondary-action" href="https://qiye.aliyun.com/alimail/entries/v5.1/mail/inbox/all" target="_blank" rel="noopener noreferrer">登录阿里邮箱</a><button className="primary-action" type="button" onClick={() => void writeRegistrationDrafts([activeRegistrationReceipt], activeRegistrationReceipt.schoolName)} disabled={busyAction !== null}>{busyAction === "alimail-drafts" ? "正在写入草稿……" : "一键写入阿里邮箱草稿"}<span>→</span></button></div>
              </>
            )}
          </>
        )}
      </section>
    </div>
  ) : null;

  const edpReceiptDialog = activeEdpReceipt ? (
    <div className="receipt-dialog-backdrop">
      <section className="receipt-dialog" role="dialog" aria-modal="true" aria-labelledby="edp-receipt-dialog-title" aria-describedby="edp-receipt-dialog-description">
        <div className="receipt-dialog-heading">
          <div><span>EDP · 阿里邮箱回执</span><h2 id="edp-receipt-dialog-title">{activeEdpReceipt.schoolName} EDP回执</h2></div>
          <button type="button" onClick={() => setActiveEdpReceipt(null)} disabled={busyAction === "alimail-edp-drafts"} aria-label="关闭 EDP 回执">×</button>
        </div>
        {activeEdpReceipt.receipt.status === "needs_configuration" ? (
          <div className="receipt-settings-required" id="edp-receipt-dialog-description">
            <strong>EDP 回执还差赛事年份和提交次数</strong>
            <p>请关闭本窗口，在 EDP 栏目填写竞赛年份，并选择本轮是第 1–5 次中的哪一次提交。保存后系统会按对应文件数量重新生成回执。</p>
            <button className="primary-action" type="button" onClick={() => setActiveEdpReceipt(null)}>返回填写 EDP 回执设置<span>→</span></button>
          </div>
        ) : (
          <>
            <div className={`receipt-assessment ${activeEdpReceipt.receipt.status}`} id="edp-receipt-dialog-description">
              <strong>{activeEdpReceipt.receipt.status === "qualified" ? "EDP 检查通过" : "EDP 检查未通过"}</strong>
              <span>第 {activeEdpReceipt.receipt.submissionRound} 次提交 · 应有 {activeEdpReceipt.receipt.expectedFileCount} 个 PDF · 当前 {activeEdpReceipt.fileCount ?? "—"} 个文件</span>
            </div>
            {activeEdpReceipt.receipt.reasons.length > 0 && <div className="receipt-reasons"><strong>本次未通过的具体原因</strong><ul>{activeEdpReceipt.receipt.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></div>}
            <dl className="receipt-mail-meta"><div><dt>收件人</dt><dd>{activeEdpReceipt.receipt.recipientEmail || "未找到该校报名表中的团队联系邮箱"}</dd></div><div><dt>邮件主题</dt><dd>{activeEdpReceipt.receipt.subject}</dd></div></dl>
            <pre className="receipt-body">{activeEdpReceipt.receipt.body}</pre>
            <p className="receipt-send-note">收件邮箱取自同一学校的最新版报名表。助手只会写入并保存阿里邮箱草稿，不会自动发送，请逐封检查后再发送。</p>
            <div className="receipt-dialog-actions"><button className="ghost-action" type="button" onClick={() => setActiveEdpReceipt(null)}>关闭</button><button className="secondary-action" type="button" onClick={() => void copyEdpReceipt(activeEdpReceipt.receipt)}>复制邮件正文</button><a className="secondary-action" href="https://qiye.aliyun.com/alimail/entries/v5.1/mail/inbox/all" target="_blank" rel="noopener noreferrer">登录阿里邮箱</a><button className="primary-action" type="button" onClick={() => void writeEdpDrafts([activeEdpReceipt], activeEdpReceipt.schoolName)} disabled={busyAction !== null}>{busyAction === "alimail-edp-drafts" ? "正在写入草稿……" : "一键写入阿里邮箱草稿"}<span>→</span></button></div>
          </>
        )}
      </section>
    </div>
  ) : null;

  const edpReviewDialog = activeEdpReview ? (
    <div className="edp-review-dialog-backdrop">
      <section className="edp-review-dialog" role="dialog" aria-modal="true" aria-labelledby="edp-review-dialog-title" aria-describedby="edp-review-dialog-description">
        <header className="edp-review-dialog-heading">
          <div><span>EDP 审核异常与证据 · 第 {activeEdpReview.job.submissionRound} 次提交</span><h2 id="edp-review-dialog-title">{activeEdpReview.job.schoolName}</h2><p id="edp-review-dialog-description">这里仅展示审核结论、意见和证据位置；正常操作无需逐项填写或保存。</p></div>
          <button ref={edpReviewCloseButtonRef} type="button" onClick={closeEdpReviewDialog} disabled={busyAction?.startsWith("edp-review") === true} aria-label="关闭 EDP 审核详情">×</button>
        </header>

        <div className="edp-review-dialog-summary">
          <div><span>审核状态</span><strong className={`review-overall ${activeEdpReview.job.overallStatus}`}>{edpReviewOverallLabel(activeEdpReview.job.overallStatus)}</strong></div>
          <div><span>阻塞定稿项</span><strong>{unresolvedReviewCount}</strong></div>
          <div><span>规则版本</span><strong>{activeEdpReview.job.ruleVersion}</strong></div>
          <div><span>源文件</span><strong title={activeEdpReview.job.sourceFilename || ""}>{activeEdpReview.job.sourceFilename || "未记录"}</strong></div>
        </div>

        {["queued","processing"].includes(activeEdpReview.job.status) && <p role="status">新一轮审核正在排队或处理中；以下为上次结果，完成后请重新打开预览。</p>}
        {activeEdpReview.job.lastError && <div className="edp-review-run-error" role="alert"><strong>上次审核未完成</strong><span>{activeEdpReview.job.lastError}</span></div>}

        <div className="edp-review-toolbar">
          <div className="edp-review-toolbar-actions">
            <button className="secondary-action" type="button" onClick={() => void recheckEdpWithLatestRule(activeEdpReview.job.jobId)} disabled={busyAction !== null || !edpReviewSettings.activeRuleVersion}>{busyAction === `edp-review-recheck:${activeEdpReview.job.jobId}` ? "正在建立复核……" : "按当前启用规则另建复核"}</button>
          </div>
          <span>共 {activeEdpReview.items.length} 项；不明确的证据保持“待人工确认”，不会猜测为合格或不合格。</span>
        </div>

        <p className="edp-review-template-note">模板说明：危险分析、实验室平面图、主要危险清单和 Chemical Information Page 为英文版专属内容；中文版模板不含这些章节，因此不会因缺少这些章节被判错。</p>

        <div className="edp-review-item-list" aria-label="EDP 审核条目">
          {EDP_REVIEW_GROUPS.map((group) => {
            const groupItems = activeEdpReview.items.filter((item) => edpReviewGroup(item) === group.id);
            if (groupItems.length === 0) return null;
            return <section className="edp-review-group" key={group.id} aria-labelledby={`edp-review-group-${group.id}`}>
              <header><h3 id={`edp-review-group-${group.id}`}>{group.label}</h3><span>{groupItems.length} 项</span></header>
              <div className="edp-review-group-items">
                {groupItems.map((item) => <article className={`edp-review-item status-${item.finalStatus}`} key={item.ruleId}>
                    <div className="edp-review-item-heading">
                      <div><span>{item.worksheetName} · Excel 第 {item.templateRow} 行</span><h3>{EDP_REVIEW_RULE_LABELS[item.ruleId] || item.ruleId}</h3><div className="edp-review-rule-meta"><b className={item.isBlocking ? "blocking" : "advisory"}>{item.isBlocking ? "影响正式结论" : "提示项"}</b><small>规则来源：{item.ruleSource}</small></div></div>
                      <em>审核结论：{EDP_REVIEW_STATUS_LABELS[item.finalStatus]}</em>
                    </div>
                    <div className="edp-review-item-comment"><strong>审核意见</strong><p>{item.finalComment || item.suggestedComment || "尚无具体意见。"}</p></div>
                    <div className="edp-review-evidence">
                      <strong>证据位置</strong>
                      {item.evidence.length === 0 ? <p>未定位到足以支持明确结论的原文，请人工查看 EDP 后确认。</p> : <ul>{item.evidence.map((evidence, evidenceIndex) => <li key={`${item.ruleId}-${evidence.filename}-${evidence.page}-${evidenceIndex}`}><span>{evidence.filename} · 第 {evidence.page} 页</span><q>{evidence.excerpt}</q></li>)}</ul>}
                    </div>
                  </article>)}
              </div>
            </section>;
          })}
        </div>

        <footer className="edp-review-export-panel">
          <div className="edp-review-export-explanation"><strong>审核结果预览</strong><span>以上内容会写入原模板的两个工作表；下载不会重新审核。有不确定证据时，Excel 保留“待人工确认”。</span></div>
          <div className="edp-review-export-actions">
            <button className="secondary-action" type="button" onClick={closeEdpReviewDialog} disabled={busyAction !== null}>关闭</button>
            <button className="primary-action" type="button" onClick={() => void downloadEdpReviews([activeEdpReview.job.jobId])} disabled={busyAction !== null || !activeEdpReview.job.reviewedAt || ["queued","processing","failed"].includes(activeEdpReview.job.status)}>下载此审核表 Excel<span>→</span></button>
          </div>
        </footer>
      </section>
    </div>
  ) : null;

  if (authState !== "authenticated") {
    return (
      <main className="auth-shell">
        <section className="auth-stage" aria-labelledby={authState === "checking" ? "auth-checking-title" : "auth-title"}>
          <div className="auth-intro">
            <div className="auth-brand"><span>CE</span><div><strong>赛事资料中心</strong><small>CHEM-E-CAR</small></div></div>
            <div className="auth-intro-copy">
              <p>COMPETITION OPERATIONS</p>
              <h1 id="auth-title">赛事文件与邮件<br />共享控制台</h1>
              <span>集中维护报名表与 EDP、阿里邮箱邮件、海报和视频，电脑与手机浏览器均可安全访问。</span>
            </div>
            <ul aria-label="平台特点"><li>所有授权用户查看同一份云端资料</li><li>每校只保留最新有效文件版本</li><li>独立密码保护赛事资料</li></ul>
          </div>

          <div className="auth-panel">
            {authState === "checking" ? (
              <div className="auth-checking" role="status" aria-live="polite">
                <span className="auth-spinner" aria-hidden="true" />
                <strong id="auth-checking-title">正在检查登录状态</strong>
                <p>请稍候，正在安全连接赛事资料中心。</p>
              </div>
            ) : (
              <form className="auth-card" onSubmit={login}>
                <div className="auth-card-heading"><span>独立密码登录</span><h2>欢迎使用</h2><p>请输入管理员提供的访问密码。</p></div>
                <label className="auth-password-label" htmlFor="access-password">访问密码</label>
                <div className="auth-password-field">
                  <input
                    id="access-password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="current-password"
                    required
                    aria-describedby={authMessage ? "auth-message" : "auth-help"}
                  />
                  <button type="button" onClick={() => setShowPassword((visible) => !visible)} aria-label={showPassword ? "隐藏密码" : "显示密码"}>{showPassword ? "隐藏" : "显示"}</button>
                </div>
                <p className="auth-help" id="auth-help">密码仅用于本次安全登录，不会保存在此设备的浏览器存储中。</p>
                {authMessage && <div className="auth-message" id="auth-message" role="alert"><span>!</span>{authMessage}</div>}
                <button className="auth-submit" type="submit" disabled={authBusy}>{authBusy ? "正在验证……" : "登录控制台"}<span>→</span></button>
                <div className="auth-founder-entry"><strong>共享密码重置说明</strong><span>请先使用当前共享密码登录，仅在确有需要时从右上角重置密码。所有电脑和手机始终只使用同一个共享登录密码。</span>{founderManagementEnabled === false && <small>服务器尚未启用创始人密码管理，请联系部署负责人。</small>}</div>
                <div className="auth-browser-note"><strong>可在任意电脑或手机浏览器登录</strong><span>无需通过 ChatGPT 打开，访问同一网址并输入密码即可。</span></div>
              </form>
            )}
          </div>
        </section>
        {founderPasswordDialog}
        <footer className="auth-footer">CHEM-E-CAR 赛事资料中心 · 受独立密码与安全会话保护</footer>
      </main>
    );
  }

  return (
    <main className="collector-shell">
      <aside className="collector-rail" aria-label="控制台导航">
        <div className="collector-brand"><div className="collector-logo">CE</div><div><strong>赛事资料中心</strong><span>CHEM-E-CAR</span></div></div>
        <nav>
          <button className={`rail-link ${activeWorkspace === "registration" ? "active" : ""}`} type="button" onClick={() => chooseWorkspace("registration")}><span>01</span>报名表统计</button>
          <button className={`rail-link ${activeWorkspace === "edp" ? "active" : ""}`} type="button" onClick={() => chooseWorkspace("edp")}><span>02</span>EDP 提交统计</button>
          <button className={`rail-link ${activeWorkspace === "edpReview" ? "active" : ""}`} type="button" onClick={() => chooseWorkspace("edpReview")}><span>03</span>EDP 审核</button>
          <button className={`rail-link ${activeWorkspace === "mail" ? "active" : ""}`} type="button" onClick={() => chooseWorkspace("mail")}><span>04</span>阿里邮箱连接</button>
          <button className={`rail-link ${activeWorkspace === "poster" ? "active" : ""}`} type="button" onClick={() => chooseWorkspace("poster")}><span>05</span>海报收集</button>
          <button className={`rail-link ${activeWorkspace === "video" ? "active" : ""}`} type="button" onClick={() => chooseWorkspace("video")}><span>06</span>视频收集</button>
          <button className={`rail-link ${activeWorkspace === "certificate" ? "active" : ""}`} type="button" onClick={() => chooseWorkspace("certificate")}><span>07</span>证书制作</button>
        </nav>
        <div className="rail-system"><i />共享云端控制台<br /><small>所有授权用户看到同一资料库</small></div>
      </aside>

      <section className="collector-main">
        <header className="collector-topbar">
          <div><p className="collector-eyebrow">COMPETITION OPERATIONS</p><h1>竞赛文件采集控制台</h1></div>
          <div className="collector-account-actions"><div className="collector-status" aria-live="polite"><i className={statusOnline ? "online" : ""} />{statusText}</div><button className="founder-password-action" type="button" onClick={openFounderPasswordDialog} disabled={authBusy || busyAction !== null}>重置密码（非必要不重置）</button><button className="logout-action" type="button" onClick={() => void logout()} disabled={authBusy || busyAction !== null}>{authBusy ? "正在退出……" : "退出登录"}</button></div>
        </header>

        {notice && <div className={`console-notice ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}><span>{notice.kind === "error" ? "!" : notice.kind === "success" ? "✓" : "i"}</span>{notice.text}</div>}

        {activeWorkspace === "registration" ? (
          <section className="workspace-view" id="registration-workspace" aria-labelledby="registration-title">
            <div className="workspace-heading"><div><span>报名表统计</span><h2 id="registration-title">报名信息与唯一统计表</h2><p>同一学校重复提交时只保留最后一版；接入采集器后，统计数据将直接更新原表。</p></div><div className="workspace-metrics"><div><strong>{registrationCount}</strong><span>学校最新版</span></div><div><strong>{master ? "1" : "0"}</strong><span>主统计表</span></div></div></div>

            <FankeControls fanke={fanke} kind="registration" label="报名表" helperInstalled={fankeHelperInstalled} helperCompatible={fankeHelperCompatible} helperVersion={fankeHelperVersion} helperProgress={fankeHelperProgress} busyAction={busyAction} savedCounts={sharedFileCounts} schedule={registrationSchedule} onScheduleChange={(next)=>changeSchedule("registration",next)} saveStatus={scheduleSaveStatus.registration || ""} onRetrySave={()=>void flushSchedule("registration")} onStart={() => void startFankeAssistant("registration")} onOpenLibrary={openFankeLibrary} onClearProblems={(kind) => void clearFankeProblemRecords(kind)} />

            <form className="console-card registration-receipt-card" onSubmit={saveRegistrationReceiptSettings}>
              <div className="section-heading"><div><span>报名回执与阿里邮箱</span><small>报名表收集后按实际问题生成回执；可一键写入草稿，绝不自动发送</small></div><em className="ready">自动生成</em></div>
              <div className="receipt-settings-fields"><label>竞赛年份（必填）<input type="text" inputMode="numeric" required pattern="20[0-9]{2}" maxLength={4} placeholder="例如 2026" value={registrationReceiptSettings.competitionYear} onChange={(event) => setRegistrationReceiptSettings({ ...registrationReceiptSettings, competitionYear: event.target.value })} /></label><label>交流 QQ 群号（必填）<input type="text" inputMode="numeric" required pattern="[0-9]{5,20}" maxLength={20} placeholder="例如 123456789" value={registrationReceiptSettings.qqGroup} onChange={(event) => setRegistrationReceiptSettings({ ...registrationReceiptSettings, qqGroup: event.target.value })} /></label><button className="primary-action" type="submit" disabled={busyAction !== null}>{busyAction === "registration-receipt-settings" ? "正在保存……" : "保存并更新全部回执"}<span>→</span></button></div>
              <div className="receipt-rule-note"><strong>自动检查与草稿规则</strong><span>只核对有效人员行；指导教师不超过 5 人、学生 5–15 人，缺什么就会在未通过回执中具体说明。写草稿前只需登录阿里邮箱并使用 v{REQUIRED_FANKE_HELPER_VERSION} 助手；助手会自动打开写信页，且只有在收件人、主题和正文逐项回读成功后才保存草稿。</span><a href="https://qiye.aliyun.com/alimail/entries/v5.1/mail/inbox/all" target="_blank" rel="noopener noreferrer">登录阿里邮箱</a></div>
            </form>

            <div className="collector-workspace">
              <form className="console-card master-card" onSubmit={uploadMaster}>
                <div className="section-heading"><div><span>唯一统计表</span><small>后续直接更新原文件</small></div><em className={master ? "ready" : "neutral"}>{master ? "已设置" : "未上传"}</em></div>
                <div className="file-summary"><div className="file-glyph">XLSX</div><div><strong>{master?.filename || masterSelection?.name || "选择参赛队伍统计表"}</strong><small>{master ? `${formatSize(master.size)} · ${formatDate(master.uploadedAt)}` : masterSelection ? "已选择，等待上传" : "仅支持 .xlsx，最大 20 MB"}</small></div></div>
                <input ref={masterInputRef} className="file-input" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => setMasterSelection(event.target.files?.[0] || null)} aria-label="选择唯一统计表" />
                <div className="card-actions"><button className="secondary-action" type="submit" disabled={busyAction !== null}>{busyAction === "master" ? "正在上传……" : master ? "替换当前统计表" : "上传统计表"}</button>{master && <><a className="text-action" href={master.downloadUrl || "/api/master/download"}>保存到本地 ↓</a><button className="danger-action" type="button" onClick={() => void deleteSharedRecord("/api/master", { uploadedAt: master.uploadedAt }, master.filename)} disabled={busyAction !== null}>删除</button></>}</div>
              </form>
            </div>

            <form className="console-card manual-card" onSubmit={uploadRegistration}>
              <div className="section-heading"><div><span>人工补录报名表</span><small>只需选择文件；系统从文件名识别学校并自动生成版本</small></div><em className="neutral">XLSX</em></div>
              <div className="manual-fields file-only"><label>Excel 报名表<input ref={registrationInputRef} type="file" required={!registrationFile} accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => setRegistrationFile(event.target.files?.[0] || null)} /></label><p>文件名请包含完整学校名称，例如“天津大学-报名表.xlsx”。</p></div>
              <button className="primary-action compact" type="submit" disabled={busyAction !== null}>{busyAction === "registration-upload" ? "正在核对版本……" : "补录并更新该校最新版"}<span>→</span></button>
            </form>

            <CollectionHelpDisclosure label="报名表" source="凡科一键增量助手或人工补录；每次只识别报名表，不下载其他栏目文件。" rule="同一学校按提交时间保留最新一版，统计表始终只有一份并在原表更新。" recollect />
            <section className="records-panel" id="registration-files">
              <div className="records-heading"><div><span>报名表清单</span><h3>每校最新版本</h3></div><strong>{registrationCount}</strong></div>
              {!loading && sortedRegistrations.length > 0 && <BulkFileActions label="报名表" allKeys={sortedRegistrations.map((item) => item.schoolKey)} selectedKeys={selectedFiles.registration} busy={busyAction === "bulk-delete:registration"} onToggleAll={(checked) => toggleAllFiles("registration", sortedRegistrations.map((item) => item.schoolKey), checked)} onDelete={() => void bulkDeleteFiles("registration")} />}
              {!loading && sortedRegistrations.length > 0 && <div className="receipt-bulk-draft-actions"><div><strong>按学校拼音顺序逐封写入阿里邮箱草稿</strong><span>每所学校单独一封：保存后自动打开下一封并继续填写，不需要手动刷新；不会发送。</span></div><button className="secondary-action" type="button" disabled={busyAction !== null || selectedFiles.registration.length === 0} onClick={() => void writeRegistrationDrafts(sortedRegistrations.filter((item) => selectedFiles.registration.includes(item.schoolKey)), "所选学校")}>{busyAction === "alimail-drafts" ? "正在自动逐封写入……" : `逐封写入所选回执（${selectedFiles.registration.length}）`}</button><button className="primary-action" type="button" disabled={busyAction !== null} onClick={() => void writeRegistrationDrafts(sortedRegistrations, "全部学校")}>{busyAction === "alimail-drafts" ? "正在自动逐封写入……" : "一键逐封写入全部已生成回执"}<span>→</span></button></div>}
              {loading ? <EmptyList title="正在读取报名表索引……" detail="请稍候。" /> : sortedRegistrations.length === 0 ? <EmptyList title="尚未收集报名表" detail="启用采集或人工补录后，这里只显示每所学校当前有效的一份。" /> : <ul className="record-list">{sortedRegistrations.map((item) => {
                const receiptLabel = item.receipt.status === "qualified" ? (item.receipt.settingsComplete ? "报名成功回执" : "报名通过·待填写回执设置") : item.receipt.status === "unqualified" ? "报名未成功回执" : "回执待生成";
                return <li key={item.schoolKey}><label className="file-select"><input type="checkbox" checked={selectedFiles.registration.includes(item.schoolKey)} onChange={(event) => toggleFileSelection("registration", item.schoolKey, event.target.checked)} /><span className="sr-only">选择 {item.schoolName} 报名表</span></label><div className="file-glyph small">XLSX</div><div className="record-primary"><strong>{item.schoolName}</strong><small>{item.filename} · {formatSize(item.size)}</small><span className={`receipt-status ${item.receipt.status}`}>{receiptLabel}</span></div><div className="record-meta">提交：{formatDate(item.submittedAt)}<br />来源：{item.submissionId.startsWith("fanke-") ? "凡科" : "人工补录"}</div><div className="record-actions"><button className="receipt-action" type="button" onClick={() => setActiveRegistrationReceipt(item)}>查看回执</button><a className="download-action" href={item.downloadUrl}>保存到本地</a><button className="danger-action" type="button" onClick={() => void deleteSharedRecord(`/api/registrations/${encodeURIComponent(item.schoolKey)}`, { submittedAt: item.submittedAt, submissionId: item.submissionId }, `${item.schoolName}报名表`)} disabled={busyAction !== null}>删除</button></div></li>;
              })}</ul>}
            </section>
          </section>
        ) : activeWorkspace === "edp" ? (
          <section className="workspace-view" id="edp-workspace" aria-labelledby="edp-title">
            <div className="workspace-heading"><div><span>EDP 提交统计</span><h2 id="edp-title">EDP 压缩包检查与清单</h2><p>分别查看通过检查的学校和需要核对文件数量或格式的学校。</p></div><div className="workspace-metrics"><div><strong>{edpQualifiedCount}</strong><span>检查合格</span></div><div className={edpNeedsReviewCount ? "issue" : ""}><strong>{edpNeedsReviewCount}</strong><span>需要核对</span></div></div></div>

            <form className="console-card registration-receipt-card" onSubmit={saveEdpReceiptSettings}>
              <div className="section-heading"><div><span>EDP 回执与阿里邮箱</span><small>先设置本轮提交次数，系统才会按正确文件数量检查并生成成功或修改回执</small></div><em className={edpReceiptSettingsComplete(edpReceiptSettings) ? "ready" : "neutral"}>{edpReceiptSettingsComplete(edpReceiptSettings) ? "已设置" : "待设置"}</em></div>
              <div className="receipt-settings-fields edp-receipt-settings-fields"><label>竞赛年份（必填）<input type="text" inputMode="numeric" required pattern="20[0-9]{2}" maxLength={4} placeholder="例如 2025" value={edpReceiptSettings.competitionYear} onChange={(event) => setEdpReceiptSettings({ ...edpReceiptSettings, competitionYear: event.target.value })} /></label><label>本轮 EDP 提交次数（必填）<select required value={edpReceiptSettings.submissionRound ?? ""} onChange={(event) => setEdpReceiptSettings({ ...edpReceiptSettings, submissionRound: parseEdpSubmissionRound(event.target.value) })}><option value="">请选择</option><option value="1">第 1 次提交</option><option value="2">第 2 次提交</option><option value="3">第 3 次提交</option><option value="4">第 4 次提交</option><option value="5">第 5 次提交</option></select></label><button className="primary-action" type="submit" disabled={busyAction !== null}>{busyAction === "edp-receipt-settings" ? "正在保存……" : "保存并更新全部 EDP 回执"}<span>→</span></button></div>
              <div className="receipt-rule-note"><strong>本轮检查规则</strong><span>{edpReceiptRuleText(edpReceiptSettings.submissionRound)} 回执收件邮箱取自同校最新版报名表；缺少或格式错误的邮箱会自动跳过，不会中断后续学校。写草稿前只需登录阿里邮箱，助手会自动打开写信页。</span><a href="https://qiye.aliyun.com/alimail/entries/v5.1/mail/inbox/all" target="_blank" rel="noopener noreferrer">登录阿里邮箱</a></div>
            </form>

            <FankeControls fanke={fanke} kind="edp" label="EDP" helperInstalled={fankeHelperInstalled} helperCompatible={fankeHelperCompatible} helperVersion={fankeHelperVersion} helperProgress={fankeHelperProgress} busyAction={busyAction} savedCounts={sharedFileCounts} schedule={edpSchedule} onScheduleChange={(next)=>changeSchedule("edp",next)} saveStatus={scheduleSaveStatus.edp || ""} onRetrySave={()=>void flushSchedule("edp")} onStart={() => void startFankeAssistant("edp")} onOpenLibrary={openFankeLibrary} onClearProblems={(kind) => void clearFankeProblemRecords(kind)} />

            <div className="collector-workspace">
              <form className="console-card manual-card edp-upload-card" onSubmit={uploadEdp}>
                <div className="section-heading"><div><span>人工补录 EDP</span><small>只需选择文件；系统识别学校、嵌套目录和压缩包内容</small></div><em className="neutral">ZIP / 7z / RAR</em></div>
                <div className="manual-fields file-only"><label>EDP 压缩包<input ref={edpInputRef} type="file" required={!edpFile} accept=".zip,.7z,.rar,application/zip,application/x-7z-compressed,application/vnd.rar" onChange={(event) => setEdpFile(event.target.files?.[0] || null)} /></label><p>ZIP / 7z / RAR，最大 20MB。文件名请包含学校名称，例如“华东理工大学-EDP（第二版）.7z”。</p></div>
                <button className="primary-action" type="submit" disabled={busyAction !== null}>{busyAction === "edp-upload" ? "正在检查压缩包……" : "上传并检查 EDP"}<span>→</span></button>
              </form>
            </div>

            <CollectionHelpDisclosure label="EDP" source="凡科一键增量助手或人工补录；仅收取经识别的 ZIP、7z 或 RAR 格式 EDP 压缩包。" rule="系统先解压压缩包，再逐份打开并验证 PDF；允许 PDF 位于学校文件夹内。Word、损坏或伪装成 PDF 的文件不会入库，并会在不合格清单中显示具体文件名。" recollect />
            <div className="edp-summary-strip"><div><span>合格学校</span><strong>{edpQualifiedCount}</strong></div><div><span>需要核对</span><strong>{edpNeedsReviewCount}</strong></div><div><span>最新学校记录</span><strong>{edpCheckedCount}</strong></div></div>
            {!loading && latestEdpReceiptItems.length > 0 && <div className="receipt-bulk-draft-actions edp-receipt-bulk-actions"><div><strong>按学校拼音顺序逐封写入 EDP 回执</strong><span>每校只采用合格文件或问题记录中提交时间较晚的一条；写入草稿但不会自动发送。</span></div><button className="secondary-action" type="button" disabled={busyAction !== null || selectedFiles.edp.length === 0} onClick={() => void writeEdpDrafts(sortedEdpSubmissions.filter((item) => selectedFiles.edp.includes(item.schoolKey)), "所选学校")}>{busyAction === "alimail-edp-drafts" ? "正在逐封写入……" : `写入所选 EDP 回执（${selectedFiles.edp.length}）`}</button><button className="primary-action" type="button" disabled={busyAction !== null} onClick={() => void writeEdpDrafts(latestEdpReceiptItems, "全部学校的最新 EDP 记录")}>{busyAction === "alimail-edp-drafts" ? "正在逐封写入……" : "一键写入全部最新 EDP 回执"}<span>→</span></button></div>}

            <div className="edp-list-grid">
              <section className="records-panel qualified-panel" id="edp-files">
                <div className="records-heading"><div><span>COLLECTED FILES</span><h3>已收集文件与回执</h3></div><strong>{sortedEdpSubmissions.length}</strong></div>
                {!loading && sortedEdpSubmissions.length > 0 && <BulkFileActions label="EDP" allKeys={sortedEdpSubmissions.map((item) => item.schoolKey)} selectedKeys={selectedFiles.edp} busy={busyAction === "bulk-delete:edp"} onToggleAll={(checked) => toggleAllFiles("edp", sortedEdpSubmissions.map((item) => item.schoolKey), checked)} onDelete={() => void bulkDeleteFiles("edp")} />}
                {loading ? <EmptyList title="正在读取 EDP 清单……" detail="请稍候。" /> : sortedEdpSubmissions.length === 0 ? <EmptyList title="暂无合格记录" detail="上传 ZIP、7z 或 RAR 并通过文件数量与格式检查后，会出现在这里。" /> : <ul className="record-list edp-records">{sortedEdpSubmissions.map((item) => <li key={`${item.schoolKey}-${item.submissionId}`}><label className="file-select"><input type="checkbox" checked={selectedFiles.edp.includes(item.schoolKey)} onChange={(event) => toggleFileSelection("edp", item.schoolKey, event.target.checked)} /><span className="sr-only">选择 {item.schoolName} EDP</span></label><span className="result-mark good">✓</span><div className="record-primary edp-record-primary"><strong>{item.schoolName}</strong><small>{item.filename} · {formatSize(item.size)} · 解压完成，{item.fileCount ?? "—"} 份 PDF 已逐份读取</small><div className="edp-meta-chips"><span>压缩格式 {item.archiveFormat?.toUpperCase() || "ZIP"}</span><span>提交轮次 {item.submissionRound ? `第 ${item.submissionRound} 次` : "待确认"}</span><span>{edpRoundSourceLabel(item.submissionRoundSource)}</span></div><div className="edp-role-chips" aria-label={`${item.schoolName} EDP 文件角色`}>{(Object.entries(EDP_DOCUMENT_ROLE_LABELS) as Array<[keyof typeof EDP_DOCUMENT_ROLE_LABELS, string]>).map(([role, label]) => <span key={role} className={item.documentRoles?.includes(role) ? "present" : "not-required"}>{label}{item.documentRoles?.includes(role) ? "（已识别并读取）" : item.submissionRound === 1 && role === "moc" ? "（本轮不要求）" : "（未识别）"}</span>)}</div>{item.embeddedRegistration && item.embeddedRegistration.status !== "none" && <div className={`embedded-registration ${item.embeddedRegistration.status}`}><strong>报名表联动：</strong>{embeddedRegistrationLabel(item.embeddedRegistration.status)}{item.embeddedRegistration.filename ? ` · ${item.embeddedRegistration.filename}` : ""}{item.embeddedRegistration.message ? ` · ${item.embeddedRegistration.message}` : ""}</div>}<div className="edp-card-status"><span className={`receipt-status ${item.receipt.status}`}>{item.receipt.status === "qualified" ? "EDP提交成功回执" : item.receipt.status === "unqualified" ? "EDP未成功回执" : "待填写回执设置"}</span><span className={`review-task-status ${item.reviewTaskStatus}`}>{item.reviewTaskStatus === "created" ? "审核任务已建立" : "审核任务待补建"}</span></div></div><div className="record-actions"><button className="receipt-action" type="button" onClick={() => setActiveEdpReceipt(item)}>查看回执</button>{item.downloadUrl && <a className="download-action" href={item.downloadUrl}>保存到本地</a>}<button className="danger-action" type="button" onClick={() => void deleteSharedRecord(`/api/edp-submissions/${encodeURIComponent(item.schoolKey)}`, { submittedAt: item.submittedAt, submissionId: item.submissionId }, `${item.schoolName} EDP`)} disabled={busyAction !== null}>删除</button></div></li>)}</ul>}
              </section>

              <section className="records-panel issue-panel">
                <div className="records-heading"><div><span>REVIEW REQUIRED</span><h3>不合格清单</h3></div><strong>{edpIssues.length}</strong></div>
                {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- this named scroll region must be keyboard-focusable */}
                {loading ? <EmptyList title="正在读取异常清单……" detail="请稍候。" /> : sortedEdpIssues.length === 0 ? <EmptyList title="当前没有异常" detail="文件数量或格式不符合要求时，会在这里明确列出原因并生成未成功回执。" /> : <div className="edp-issue-scroll" role="region" aria-label="全部 EDP 文件问题" tabIndex={0}><ul className="record-list edp-records">{sortedEdpIssues.map((item) => <li key={`${item.schoolKey || item.schoolName}-${item.submissionId || item.submittedAt || item.filename || "issue"}`}><span className="result-mark bad">!</span><div className="record-primary"><strong>{item.schoolName}</strong><small>{item.filename ? `${item.filename} · ` : ""}{item.fileCount ?? "—"} 个文件 · {item.receipt.reasons.join("；") || item.reasons?.join("；") || item.reason || item.formatReason || item.formats?.join("、") || "格式需要核对"}</small><div className="edp-card-status"><span className="review-task-status missing">未入库</span><span className={`receipt-status ${item.receipt.status}`}>{item.receipt.settingsComplete ? "EDP未成功回执" : "待填写回执设置"}</span></div></div><div className="record-actions"><button className="receipt-action" type="button" onClick={() => setActiveEdpReceipt(item)}>查看回执</button>{item.schoolKey && item.submittedAt && item.submissionId && <button className="danger-action" type="button" onClick={() => void deleteSharedRecord(`/api/edp-issues/${encodeURIComponent(item.schoolKey || "")}`, { submittedAt: item.submittedAt, submissionId: item.submissionId }, `${item.schoolName}问题记录`)} disabled={busyAction !== null}>删除记录</button>}</div></li>)}</ul></div>}
              </section>
            </div>
          </section>
        ) : activeWorkspace === "edpReview" ? (
          <section className="workspace-view" id="edpReview-workspace" aria-labelledby="edp-review-title">
            <div className="workspace-heading"><div><span>EDP 审核</span><h2 id="edp-review-title">严格证据审核与意见表</h2><p>只审核 EDP 提交统计中每所学校最新且通过文件检查的压缩包；系统不确定时统一标为“待人工确认”。</p></div><div className="workspace-metrics edp-review-metrics" aria-label="EDP 审核状态统计"><div className={edpReviewQueuedCount ? "issue" : ""}><strong>{edpReviewQueuedCount}</strong><span>待审核</span></div><div><strong>{edpReviewProcessingCount}</strong><span>审核中</span></div><div className={edpReviewNeedsHumanCount ? "issue" : ""}><strong>{edpReviewNeedsHumanCount}</strong><span>待人工确认</span></div><div><strong>{edpReviewCompletedCount}</strong><span>已完成</span></div><div className={edpReviewMissingCount ? "issue" : ""}><strong>{edpReviewMissingCount}</strong><span>待补建</span></div></div></div>

            <CollectionHelpDisclosure label="EDP 审核意见" source="自动采用 EDP 提交统计中每校最新且通过文件检查的压缩包。" rule="提交回执与技术审核分开；系统逐项定位证据，不确定时保留“待人工确认”，每校可生成一份双工作表 Excel。" />

            <section className="console-card edp-rule-card" aria-labelledby="edp-rule-title">
              <div className="section-heading"><div><span>年度竞赛规则</span><small>每年上传新规则 PDF，人工确认后才会用于新建审核；旧审核始终保留原版本</small></div><em className={edpReviewSettings.activeRuleVersion ? "ready" : "neutral"}>{edpReviewSettings.activeRuleVersion ? "已启用" : "仅使用内置规则"}</em></div>
              <form className="edp-rule-upload" onSubmit={uploadEdpRule}>
                <label>适用年份<input type="text" inputMode="numeric" required pattern="20[0-9]{2}" maxLength={4} value={edpRuleYear} onChange={(event) => setEdpRuleYear(event.target.value)} /></label>
                <label className="edp-rule-file">年度规则 PDF<input ref={edpRuleInputRef} type="file" accept="application/pdf,.pdf" required onChange={(event) => setEdpRuleFile(event.target.files?.[0] ?? null)} /><span>{edpRuleFile ? `${edpRuleFile.name} · ${formatSize(edpRuleFile.size)}` : "选择 PDF，最大 50MB"}</span></label>
                <button className="primary-action" type="submit" disabled={busyAction !== null}>{busyAction === "edp-rule-upload" ? "正在上传并解析……" : "上传并解析规则 PDF"}<span>→</span></button>
              </form>
              <div className="edp-rule-current"><strong id="edp-rule-title">当前审核依据</strong><span>{edpReviewSettings.activeRuleVersion ? `版本 ${edpReviewSettings.activeRuleVersion}` : "尚未启用年度 PDF；新任务暂用内置规则 v1。"}</span></div>
              <div className="edp-rule-history" aria-label="年度竞赛规则版本">
                {edpRuleDocuments.length === 0 ? <p>尚未上传年度竞赛规则 PDF。</p> : edpRuleDocuments.map((document) => <article key={document.documentId} className={`rule-status-${document.status}`}>
                  <div><strong>{document.applicableYear} · {document.filename}</strong><span>{formatSize(document.size)} · {edpRuleStatusLabel(document.status)} · 候选规则事实 {document.factCount} 条</span><small>检测年份：{document.detectedYear ?? "未识别"}{document.yearConflict ? `（与填写年份 ${document.enteredYear} 不一致）` : ""} · 版本 {document.ruleVersion}</small>{document.parseError && <small className="edp-rule-error">{document.parseError}</small>}</div>
                  <div className="edp-rule-actions">
                    <button className="ghost-action" type="button" onClick={() => void loadEdpRuleDetail(document.documentId)} disabled={busyAction !== null}>{busyAction === `edp-rule-open:${document.documentId}` ? "正在读取……" : "查看解析"}</button>
                    <a className="download-action" href={`/api/edp-rule-documents/${encodeURIComponent(document.documentId)}/download`} download>下载原规则</a>
                    {document.status === "needs_confirmation" && <button className="secondary-action" type="button" onClick={() => void activateEdpRule(document)} disabled={busyAction !== null}>{busyAction === `edp-rule-activate:${document.documentId}` ? "正在启用……" : "确认并启用"}</button>}
                    {(document.status === "needs_confirmation" || document.status === "failed") && <button className="danger-action" type="button" onClick={() => void deleteEdpRule(document)} disabled={busyAction !== null}>{busyAction === `edp-rule-delete:${document.documentId}` ? "正在删除……" : "删除候选"}</button>}
                  </div>
                </article>)}
              </div>
              {activeEdpRuleDetail && <div className="edp-rule-detail">
                <div className="edp-rule-change-summary"><strong>变化摘要</strong><span>新增 {activeEdpRuleDetail.changes.added.length} 条 · 删除 {activeEdpRuleDetail.changes.removed.length} 条 · 变化 {activeEdpRuleDetail.changes.changed.length} 条</span></div>
                <details open={activeEdpRuleDetail.document.status === "needs_confirmation"}><summary>候选规则事实（{activeEdpRuleDetail.facts.length} 条）</summary>
                  {activeEdpRuleDetail.document.warnings.length > 0 && <ul className="edp-rule-warnings">{activeEdpRuleDetail.document.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
                  {activeEdpRuleDetail.facts.length === 0 ? <p>没有提取到可结构化的规则事实；启用后仍会保留内置审核并将不确定内容交由人工确认。</p> : <ul className="edp-rule-facts">{activeEdpRuleDetail.facts.map((fact) => <li key={fact.factId}><span>第 {fact.page} 页 · {fact.confidence === "high" ? "高置信" : fact.confidence === "medium" ? "中置信" : "低置信"}</span><strong>{fact.normalizedRequirement}</strong><small>{fact.excerpt}</small></li>)}</ul>}
                </details>
              </div>}
            </section>

            <form className="console-card edp-review-settings" onSubmit={saveEdpReviewSettings}>
              <div className="section-heading"><div><span>审核意见表设置</span><small>只需选择竞赛年份；固定人员信息会自动写入每份审核 Excel</small></div><em className={/^20\d{2}$/u.test(edpReviewSettings.competitionYear) ? "ready" : "neutral"}>{/^20\d{2}$/u.test(edpReviewSettings.competitionYear) ? "已设置" : "待设置"}</em></div>
              <div className="edp-review-settings-grid">
                <label className="edp-review-year">竞赛年份（必填）<select required value={edpReviewSettings.competitionYear} onChange={(event) => setEdpReviewSettings({ ...edpReviewSettings, competitionYear: event.target.value })}><option value="">请选择年份</option>{edpReviewYearOptions.map((year) => <option key={year} value={year}>{year}</option>)}</select></label>
                <div className="review-personnel-chip"><span>安全与规则审查人</span><strong>{edpReviewSettings.safetyReviewerName || FIXED_EDP_REVIEW_PERSONNEL.safetyReviewerName}</strong></div>
                <div className="review-personnel-chip"><span>安全与规则审查人邮箱</span><strong>{edpReviewSettings.safetyReviewerEmail || FIXED_EDP_REVIEW_PERSONNEL.safetyReviewerEmail}</strong></div>
                <div className="review-personnel-chip"><span>专家组成员</span><strong>{edpReviewSettings.expertMemberName || FIXED_EDP_REVIEW_PERSONNEL.expertMemberName}</strong></div>
                <button className="primary-action" type="submit" disabled={busyAction !== null}>{busyAction === "edp-review-settings" ? "正在保存……" : "保存审核设置"}<span>→</span></button>
              </div>
              <p className="schedule-note">模板版本：{edpReviewSettings.templateVersion}。{edpReviewSettings.updatedAt ? `最近更新：${formatDate(edpReviewSettings.updatedAt)}。` : "尚未保存审核设置。"}</p>
            </form>

            <section className="records-panel edp-review-list" aria-labelledby="edp-review-list-title">
              <div className="records-heading"><div><span>LATEST QUALIFIED EDP</span><h3 id="edp-review-list-title">每校最新审核任务</h3></div><div className="edp-review-list-actions"><button className="ghost-action" type="button" onClick={() => void refreshEdpReviews({ sync: true, announce: true })} disabled={edpReviewLoading || busyAction !== null}>{edpReviewLoading ? "正在同步……" : "同步并刷新审核任务"}</button><strong>{sortedEdpReviewJobs.length}</strong></div></div>
              <p className="schedule-note">合格 EDP 自动排队审核。先查看结果，再决定是否下载；技术失败不会被当成文件不合格。</p>
              {autoReviewError && <p className="fanke-error" role="status">{autoReviewError}</p>}
              {edpReviewSyncSummary && <div className={`edp-review-sync-summary ${edpReviewSyncSummary.failed ? "has-failures" : ""}`} role="status"><div><strong>审核任务同步结果</strong><span>已补建 {edpReviewSyncSummary.created} 个 · 已有任务 {edpReviewSyncSummary.existing} 个 · 补建失败 {edpReviewSyncSummary.failed} 个{edpReviewSyncSummary.historicalRoundInferences ? ` · 已补全历史轮次 ${edpReviewSyncSummary.historicalRoundInferences} 个` : ""}</span></div>{edpReviewSyncSummary.failures.length > 0 && <details><summary>查看补建失败学校</summary><ul>{edpReviewSyncSummary.failures.map((failure) => <li key={failure.schoolKey}><strong>{failure.schoolName}</strong><span>{failure.message}</span></li>)}</ul></details>}</div>}
              {!edpReviewLoading && edpReviewMissingCount > 0 && <div className="edp-review-missing-note" role="status"><strong>存在合格 EDP，审核任务待补建</strong><span>请点击“同步并刷新审核任务”；可以建立的学校会继续显示，单个失败不会阻断其他学校。</span></div>}
              {sortedEdpReviewJobs.length > 0 && <div className="edp-review-bulk-actions">
                <label><input type="checkbox" checked={sortedEdpReviewJobs.every((job) => selectedEdpReviewJobIds.includes(job.jobId))} onChange={(event) => setSelectedEdpReviewJobIds(event.target.checked ? sortedEdpReviewJobs.map((job) => job.jobId) : [])} /><span>全选本栏 {sortedEdpReviewJobs.length} 所学校</span></label>
                <div><span>已选择 {selectedEdpReviewJobIds.length} 所</span>
                  <button className="secondary-action" type="button" onClick={()=>void downloadEdpReviews(selectedEdpReviewJobIds)} disabled={busyAction!==null || !selectedEdpReviewJobIds.length}>下载所选结果</button>
                  <button className="primary-action" type="button" onClick={()=>void downloadEdpReviews(sortedEdpReviewJobs.filter(job=>job.reviewedAt && !["queued","processing","failed"].includes(job.status)).map(job=>job.jobId))} disabled={busyAction!==null}>一键下载全部已完成</button>
                  <details><summary>重新审核</summary><button className="ghost-action" type="button" onClick={()=>void queueEdpReviews(selectedEdpReviewJobIds)} disabled={busyAction!==null || !selectedEdpReviewJobIds.length}>重新审核所选</button><button className="ghost-action" type="button" onClick={()=>void queueEdpReviews(sortedEdpReviewJobs.map(job=>job.jobId))} disabled={busyAction!==null}>全部重新审核</button></details>
                  <button className="danger-action" type="button" onClick={()=>void deleteEdpReviewBatch(selectedEdpReviewJobIds)} disabled={busyAction!==null || !selectedEdpReviewJobIds.length}>删除所选</button>
                  <button className="danger-action" type="button" onClick={()=>void deleteEdpReviewBatch(sortedEdpReviewJobs.map(job=>job.jobId))} disabled={busyAction!==null}>一键清空本栏（{sortedEdpReviewJobs.length}）</button>
                </div>
              </div>}
              {edpReviewDeleteReport && <div className={`edp-review-delete-report ${edpReviewDeleteReport.failures.length ? "has-failures" : ""}`} role="status"><strong>删除结果：成功 {edpReviewDeleteReport.deletedCount} 所，失败 {edpReviewDeleteReport.failures.length} 所。</strong>{edpReviewDeleteReport.failures.length > 0 && <ul>{edpReviewDeleteReport.failures.map((failure, index) => <li key={`${failure.schoolName}-${index}`}>{failure.schoolName}：{failure.message}</li>)}</ul>}</div>}
              {edpReviewLoading ? <EmptyList title="正在读取审核任务……" detail="请稍候。" /> : sortedEdpReviewJobs.length === 0 ? <EmptyList title={edpSubmissions.length === 0 ? "尚无通过格式与数量检查的 EDP" : "存在合格 EDP，审核任务待补建"} detail={edpSubmissions.length === 0 ? "EDP 通过压缩格式、文件数量与角色检查后，会在这里建立审核任务。" : "点击上方“同步并刷新审核任务”尝试补建；无法推断历史轮次的学校会单独列出原因。"} /> : <ul>{sortedEdpReviewJobs.map((job) => <li key={job.jobId}>
                <input className="edp-review-job-select" type="checkbox" aria-label={`选择 ${job.schoolName}`} checked={selectedEdpReviewJobIds.includes(job.jobId)} onChange={(event) => toggleEdpReviewSelection(job.jobId, event.target.checked)} />
                <div className={`edp-review-job-mark ${job.overallStatus}`}>{job.submissionRound}</div>
                <div className="record-primary"><strong>{job.schoolName}</strong><small>{job.sourceFilename || "EDP 压缩包"} · 提交 {formatDate(job.submittedAt)}</small><div className="edp-meta-chips"><span>提交轮次 第 {job.submissionRound} 次</span><span>压缩格式 {(job.archiveFormat || "zip").toUpperCase()}</span><span>审核年份 {edpReviewSettings.competitionYear || "未设置"}</span><span>{edpRoundSourceLabel(job.submissionRoundSource)}</span></div>{job.lastError && <details className="edp-review-job-error"><summary>查看技术错误</summary><p>{job.lastError}</p></details>}</div>
                <div className="edp-review-job-status"><span className={`review-overall ${job.overallStatus}`}>{edpReviewJobLabel(job.status, job.overallStatus)}</span><small>{job.reviewedAt ? `最近审核 ${formatDate(job.reviewedAt)}` : `规则 ${job.ruleVersion}`}</small></div>
                <div className="edp-review-row-actions">
                  <button className="primary-action" type="button" onClick={event=>void openEdpReview(job.jobId,event.currentTarget)} disabled={busyAction!==null || !job.reviewedAt}>查看审核结果</button>
                  <button className="ghost-action" type="button" onClick={()=>void downloadEdpReviews([job.jobId])} disabled={busyAction!==null || !job.reviewedAt || ["queued","processing","failed"].includes(job.status)}>下载 Excel</button>
                  <button className="ghost-action" type="button" onClick={()=>void queueEdpReviews([job.jobId])} disabled={busyAction!==null || job.status==="processing"}>{job.status==="failed"?"重试审核":"重新审核"}</button>
                  <button className="danger-action" type="button" onClick={()=>void deleteEdpReviewSubmission(job)} disabled={busyAction!==null}>删除此 EDP</button>
                </div>
              </li>)}</ul>}
            </section>
          </section>
        ) : activeWorkspace === "mail" ? (
          <section className="workspace-view" id="mail-workspace" aria-labelledby="mail-title">
            <div className="workspace-heading"><div><span>阿里邮箱连接</span><h2 id="mail-title">邮箱连接与附件共享</h2><p>连接赛事阿里邮箱，按日期和频率收取邮件附件；所有授权用户看到同一份共享记录。</p></div><div className="workspace-metrics"><div><strong>{mailMessages.length}</strong><span>共享邮件</span></div><div><strong>{attachmentCount}</strong><span>共享附件</span></div><div className={mailMediaCandidates.length ? "issue" : ""}><strong>{mailMediaCandidates.length}</strong><span>附件待确认</span></div></div></div>

            <CollectionHelpDisclosure label="邮箱附件" source="服务器 IMAP 连接与已登录阿里邮箱的浏览器采集助手；不会发送、删除、移动或标记原邮件。" rule="邮件与附件保存到本站共享云端；不明确的海报或视频先进入待确认清单。" />

            <details className="mail-advanced-disclosure">
              <summary>邮箱服务器连接与定时设置（高级）</summary>
              <div className="mail-advanced-content">
            <div className="mail-external-card"><div><span>人工查看</span><strong>需要直接处理原始邮件时，可打开阿里邮箱收件箱</strong><p>该链接仅用于人工查看，不会代替本站自动收取。阿里邮箱普通收件附件官方上限为 100MB；本站当前安全解析单附件上限为 20MB。1GB 文件只能作为“超大附件”临时下载链接出现，不是普通 IMAP 附件，暂不能自动归档。</p></div><a href="https://qiye.aliyun.com/alimail/entries/v5.1/mail/inbox/all" target="_blank" rel="noopener noreferrer">打开阿里邮箱收件箱 <span aria-hidden="true">↗</span></a></div>

            <form className="console-card mail-settings-card" onSubmit={saveMailSettings}>
              <div className="section-heading"><div><span>阿里邮箱 IMAP 与定时设置</span><small>建议生成客户端安全密码，不要填写网页登录密码 · <a className="mail-help-link" href="https://help.aliyun.com/zh/document_detail/444269.html" target="_blank" rel="noopener noreferrer">如何生成三方客户端安全密码 ↗</a></small></div><em className={mailSettings.credentialConfigured ? "ready" : "neutral"}>{mailSettings.credentialConfigured ? "已保存凭据" : "未保存凭据"}</em></div>
              <div className="mail-account-fields">
                <label>邮箱账号<input type="email" required placeholder="registration@example.com" value={mailSettings.email} onChange={(event) => setMailSettings({ ...mailSettings, email: event.target.value })} /></label>
                <label>IMAP 服务器<input type="text" required placeholder="imap.qiye.aliyun.com" value={mailSettings.imapHost} onChange={(event) => setMailSettings({ ...mailSettings, imapHost: event.target.value })} /></label>
                <label>IMAP 端口<input type="number" required min="1" max="65535" value={mailSettings.imapPort} onChange={(event) => setMailSettings({ ...mailSettings, imapPort: Number(event.target.value) })} /></label>
                <label>安全密码<input type="password" autoComplete="new-password" placeholder={mailSettings.credentialConfigured ? "留空则沿用已保存密码" : "输入客户端安全密码"} value={mailSecurityPassword} onChange={(event) => setMailSecurityPassword(event.target.value)} /></label>
              </div>
              <div className="mail-schedule-block"><ScheduleFields schedule={mailSchedule} onChange={setMailSchedule} enableLabel="启用服务器定时收取" /></div>
              <div className="mail-action-row">
                <button className="secondary-action" type="button" onClick={() => void testMailConnection()} disabled={busyAction !== null || !mailSettings.credentialConfigured}>{busyAction === "mail-test" ? "正在测试……" : "测试连接"}</button>
                <button className="secondary-action" type="button" onClick={() => void syncMailNow()} disabled={busyAction !== null || !mailSettings.credentialConfigured}>{busyAction === "mail-sync" ? "正在收取……" : "立即收取邮件"}</button>
                <button className="primary-action" type="submit" disabled={busyAction !== null}>{busyAction === "mail-settings" ? "正在保存……" : "保存邮箱与定时设置"}<span>→</span></button>
              </div>
              <p className="schedule-note">{mailSchedule.startDate ? `只搜索 ${mailSchedule.startDate} 及之后的邮件。` : "尚未设置邮件日期下限。"} 频率：{frequencySummary(mailSchedule)}。{mailSettings.lastSyncAt ? `最近收取：${formatDate(mailSettings.lastSyncAt)}。` : "尚未记录收取时间。"}{mailSettings.nextRunAt && mailSchedule.enabled ? ` 下次收取：${formatDate(mailSettings.nextRunAt)}。` : ""}</p>
            </form>
              </div>
            </details>

            <section className="records-panel mail-candidate-panel" aria-labelledby="mail-candidate-title">
              <div className="records-heading"><div><span>MAIL ATTACHMENTS · AI / JPG / MP4 / ARCHIVES</span><h3 id="mail-candidate-title">邮箱附件待确认</h3></div><strong>{mailMediaCandidates.length}</strong></div>
              <p className="candidate-panel-intro">系统识别到海报或视频附件但无法确定归属学校时，会先留在这里。输入学校名称，或从已有学校中选择后再确认归档。</p>
              <datalist id="mail-candidate-school-options">{schoolOptions.map((schoolName) => <option key={schoolName} value={schoolName} />)}</datalist>
              {mailCandidateError && <div className="candidate-load-warning" role="status"><span>!</span>{mailCandidateError} {mailMediaCandidates.length > 0 ? "当前显示控制台中已有的待确认记录。" : "请稍后刷新。"}</div>}
              {loading ? <EmptyList title="正在读取待确认附件……" detail="请稍候。" /> : mailMediaCandidates.length === 0 ? <EmptyList title="当前没有待确认附件" detail="需要人工指定学校的海报、视频或其 ZIP/7z/RAR 压缩包会显示在这里。" /> : <ul className="mail-candidate-list">{mailMediaCandidates.map((candidate, index) => {
                const id = mailCandidateId(candidate);
                const inferredSchool = mailCandidateSchool(candidate);
                const receivedAt = candidate.receivedAt || candidate.received_at || candidate.sentAt || candidate.createdAt;
                const downloadUrl = mailCandidateDownloadUrl(candidate);
                const candidateStatus = candidate.status || "pending";
                const canAssign = candidateStatus === "pending" || candidateStatus === "retry";
                const fieldId = `mail-candidate-school-${index}`;
                return <li key={id || `${mailCandidateFilename(candidate)}-${index}`}>
                  <div className="candidate-file-glyph">{mailCandidateFormat(candidate)}</div>
                  <div className="candidate-detail">
                    <div className="candidate-title-row"><div><strong>{mailCandidateFilename(candidate)}</strong><span>来源：邮箱</span></div>{downloadUrl && <a className="text-action" href={downloadUrl}>下载核对</a>}</div>
                    <dl><div><dt>邮件主题</dt><dd>{candidate.subject || "（无主题邮件）"}</dd></div><div><dt>发件人</dt><dd>{mailCandidateSender(candidate)}</dd></div><div><dt>收到时间</dt><dd>{formatDate(receivedAt)}</dd></div><div><dt>推测学校</dt><dd>{inferredSchool || "暂未推测"}</dd></div><div className="candidate-reason"><dt>待确认原因</dt><dd>{mailCandidateReason(candidate)}</dd></div></dl>
                    {canAssign ? <form className="candidate-assign-form" onSubmit={(event) => void assignMailMediaCandidate(candidate, event)}><label htmlFor={fieldId}>归属学校<input id={fieldId} type="text" required list="mail-candidate-school-options" placeholder="输入或选择学校名称" value={id ? mailCandidateAssignments[id] || "" : inferredSchool} onChange={(event) => id && setMailCandidateAssignments((current) => ({ ...current, [id]: event.target.value }))} /></label><button className="primary-action" type="submit" disabled={!id || busyAction !== null}>{busyAction === `mail-candidate:${id}` ? "正在确认……" : "确认归档"}<span>→</span></button></form> : <div className={`candidate-status-block ${candidateStatus === "invalid" ? "invalid" : "processing"}`}>{candidateStatus === "invalid" ? "格式检查未通过，文件未归档；请联系该学校重新提交正确格式。" : "系统正在处理此附件，请稍后刷新。"}</div>}
                  </div>
                </li>;
              })}</ul>}
            </section>

            <details className="mail-records-disclosure">
              <summary>查看已收取的原始邮件与问题记录（{mailMessages.length} 封）</summary>
              <div className="mail-list-grid">
              <section className="records-panel mail-message-panel">
                <div className="records-heading"><div><span>SHARED INBOX</span><h3>邮件与附件</h3></div><strong>{mailMessages.length}</strong></div>
                {loading ? <EmptyList title="正在读取共享邮件……" detail="请稍候。" /> : mailMessages.length === 0 ? <EmptyList title="尚未收取邮件" detail="保存邮箱凭据后点击“立即收取邮件”，或启用定时计划。" /> : <ul className="record-list mail-records">{mailMessages.map((message) => {
                  const attachments = message.attachments || [];
                  const sender = message.sender || message.from || [message.fromName, message.fromAddress].filter(Boolean).join(" <") + (message.fromName && message.fromAddress ? ">" : "");
                  return <li key={mailMessageKey(message)}><div className="mail-record-body"><div className="record-primary"><strong>{message.subject || "（无主题邮件）"}</strong><small>{message.schoolName ? `${message.schoolName} · ` : ""}{sender || "发件人未知"}</small></div><div className="record-meta">收到：{formatDate(message.receivedAt || message.sentAt || message.createdAt)}<br />附件：{attachments.length} 个</div>{attachments.length > 0 && <div className="attachment-list" aria-label={`${message.subject || "邮件"}的附件`}>{attachments.map((attachment, attachmentIndex) => <div className="attachment-row" key={attachment.id || `${attachment.filename}-${attachmentIndex}`}><a href={attachment.downloadUrl}><span>{attachment.filename}</span><small>{formatSize(attachment.size)} · 保存到本地</small></a>{attachment.deleteUrl && <button className="danger-action" type="button" onClick={() => void deleteSharedRecord(attachment.deleteUrl || "", { filename: attachment.filename }, `邮件附件 ${attachment.filename}`)} disabled={busyAction !== null}>删除</button>}</div>)}</div>}</div></li>;
                })}</ul>}
                {!loading && mailMessages.length > 0 && mailNextCursor && <div className="load-more-row"><button className="ghost-action" type="button" onClick={() => void loadMoreMailMessages()} disabled={busyAction !== null}>{busyAction === "mail-load-more" ? "正在加载更多邮件……" : "加载更多历史邮件"}</button></div>}
              </section>

              <section className="records-panel issue-panel mail-issue-panel">
                <div className="records-heading"><div><span>REVIEW REQUIRED</span><h3>邮件收取问题</h3></div><strong>{mailIssues.length}</strong></div>
                {loading ? <EmptyList title="正在读取问题清单……" detail="请稍候。" /> : mailIssues.length === 0 ? <EmptyList title="当前没有收取问题" detail="连接、解析或附件收集异常会在这里说明。" /> : <ul className="record-list edp-records">{mailIssues.map((issue, index) => <li key={issue.id || issue.messageId || index}><span className="result-mark bad">!</span><div className="record-primary"><strong>{issue.schoolName || issue.subject || "邮件收取异常"}</strong><small>{issue.reason || issue.message || "请核对邮箱设置或邮件附件。"}</small></div><div className="record-meta">{issue.sender || issue.fromAddress || ""}<br />{formatDate(issue.createdAt)}</div></li>)}</ul>}
              </section>
              </div>
            </details>
          </section>
        ) : activeWorkspace === "certificate" ? (
          <CertificateWorkspace />
        ) : (
          <section className="workspace-view" id={`${activeMediaKind}-workspace`} aria-labelledby={`${activeMediaKind}-title`}>
            <div className="workspace-heading"><div><span>{mediaLabel}收集</span><h2 id={`${activeMediaKind}-title`}>{mediaLabel}共享资料库</h2><p>按学校维护最新版本；新文件通过服务器分片上传并覆盖旧版，所有授权用户共享查看和下载。</p></div><div className="workspace-metrics"><div><strong>{activeMediaRecords.length}</strong><span>学校最新版</span></div><div><strong>{activeMediaKind === "poster" ? "AI/JPG/压缩包" : "MP4/压缩包"}</strong><span>允许格式</span></div></div></div>

            <AliMailMediaControls
              kind={activeMediaKind}
              label={mediaLabel}
              schedule={activeMediaSchedule}
              checkpoint={browserMailCheckpoints[activeMediaKind]}
              counts={browserMailCounts}
              helperInstalled={fankeHelperInstalled}
              helperCompatible={fankeHelperCompatible}
              helperVersion={fankeHelperVersion}
              progress={mailMediaProgress}
              busyAction={busyAction}
              onScheduleChange={(next)=>changeSchedule(activeMediaKind,next)}
              saveStatus={scheduleSaveStatus[activeMediaKind] || ""}
              onRetrySave={()=>void flushSchedule(activeMediaKind)}
              onScanNow={() => void startAliMailMediaScan(activeMediaKind)}
            />

            <CollectionHelpDisclosure label={mediaLabel} source="已登录阿里邮箱的浏览器采集助手或人工补录；不再从凡科收取。" rule={`同校只保留最新版；${activeMediaKind === "poster" ? "允许 AI、JPG、ZIP、7z、RAR" : "允许 MP4、ZIP、7z、RAR"}，单文件上限 200MB。`} />

            <form className="console-card manual-card media-upload-card" onSubmit={(event) => void uploadMedia(activeMediaKind, event)}>
              <div className="section-heading"><div><span>人工补录{mediaLabel}</span><small>只需选择文件；系统从文件名识别学校并以 8MB 分片写入共享云端</small></div><em className="neutral">{activeMediaKind === "poster" ? "AI / JPG / 压缩包" : "MP4 / 压缩包"}</em></div>
              <div className="manual-fields file-only"><label>{mediaLabel}文件<input ref={mediaInputRef} type="file" required={!mediaFile} accept={activeMediaKind === "poster" ? ".ai,.jpg,.jpeg,.zip,.7z,.rar,application/postscript,image/jpeg,application/zip,application/x-7z-compressed,application/vnd.rar" : ".mp4,.zip,.7z,.rar,video/mp4,application/zip,application/x-7z-compressed,application/vnd.rar"} onChange={(event) => setMediaFile(event.target.files?.[0] || null)} /></label><p>文件名请包含完整学校名称和资料类型，例如“天津大学-海报.zip”或“天津大学-宣传视频.mp4”。</p></div>
              {mediaFile && <div className="selected-upload"><span>{mediaFile.name}</span><small>{formatSize(mediaFile.size)} · 将作为该校最新版上传</small></div>}
              {uploadStatus && <div className="upload-progress" role="status" aria-live="polite"><span aria-hidden="true" />{uploadStatus}</div>}
              <button className="primary-action compact" type="submit" disabled={busyAction !== null}>{busyAction === `${activeMediaKind}-upload` ? `正在上传${mediaLabel}……` : `上传并更新该校最新${mediaLabel}`}<span>→</span></button>
            </form>

            <section className="records-panel" id={`${activeMediaKind}-files`}>
              <div className="records-heading"><div><span>{activeMediaKind === "poster" ? "POSTER LIBRARY" : "VIDEO LIBRARY"}</span><h3>每校最新{mediaLabel}</h3></div><strong>{activeMediaRecords.length}</strong></div>
              {!loading && activeMediaRecords.some((item) => item.schoolKey) && <BulkFileActions label={mediaLabel} allKeys={activeMediaRecords.flatMap((item) => item.schoolKey ? [item.schoolKey] : [])} selectedKeys={selectedFiles[activeMediaKind]} busy={busyAction === `bulk-delete:${activeMediaKind}`} onToggleAll={(checked) => toggleAllFiles(activeMediaKind, activeMediaRecords.flatMap((item) => item.schoolKey ? [item.schoolKey] : []), checked)} onDelete={() => void bulkDeleteFiles(activeMediaKind)} />}
              {loading ? <EmptyList title={`正在读取${mediaLabel}清单……`} detail="请稍候。" /> : activeMediaRecords.length === 0 ? <EmptyList title={`尚未收集${mediaLabel}`} detail={`上传后，这里会为每所学校保留一份最新${mediaLabel}。`} /> : <ul className="record-list media-records">{activeMediaRecords.map((item, index) => { const sourceLabel = mediaSourceLabel(item.source, item.submissionId); return <li key={item.id || item.schoolKey || `${item.schoolName}-${item.submissionId}-${index}`}>{item.schoolKey && <label className="file-select"><input type="checkbox" checked={selectedFiles[activeMediaKind].includes(item.schoolKey)} onChange={(event) => toggleFileSelection(activeMediaKind, item.schoolKey || "", event.target.checked)} /><span className="sr-only">选择 {item.schoolName} {mediaLabel}</span></label>}<div className="file-glyph small">{mediaFormatLabel(item.filename, activeMediaKind)}</div><div className="record-primary"><div className="media-record-title"><strong>{item.schoolName}</strong><span className={`media-source-tag ${sourceLabel === "邮箱" ? "mail" : "website"}`}>来源：{sourceLabel}</span></div><small>{item.filename} · {formatSize(item.size)}</small></div><div className="record-meta">提交：{formatDate(item.submittedAt)}<br />上传：{formatDate(item.uploadedAt)}</div><div className="record-actions"><a className="download-action" href={item.downloadUrl}>保存到本地</a>{item.schoolKey && <button className="danger-action" type="button" onClick={() => void deleteSharedRecord(`/api/media/${activeMediaKind}/${encodeURIComponent(item.schoolKey || "")}`, { submittedAt: item.submittedAt, submissionId: item.submissionId }, `${item.schoolName}${mediaLabel}`)} disabled={busyAction !== null}>删除</button>}</div></li>; })}</ul>}
            </section>
          </section>
        )}

        <div className="refresh-row"><button className="ghost-action" type="button" onClick={() => void loadDashboard(true)} disabled={loading || busyAction !== null}>刷新服务器状态 ↻</button></div>
      </section>
      {founderPasswordDialog}
      {registrationReceiptDialog}
      {edpReceiptDialog}
      {edpReviewDialog}
    </main>
  );
}
