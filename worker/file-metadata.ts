export interface ManualFileMetadata {
  schoolName: string;
  submittedAt: string;
  submissionId: string;
}

const SCHOOL_SUFFIX = "(?:大学|学院|职业技术学院|研究院|学校|中学)";
const NON_CAMPUS_QUALIFIER = /报名|参赛|团队|车队|学院|学部|系|实验室|工作室|第?[一二三四五六七八九十0-9]+版|最终版|定稿|更新版|新版|edp|海报|poster|视频|video/iu;
const KNOWN_CAMPUS_NAMES: Array<{ pattern: RegExp; name: string }> = [
  {
    pattern: /中国石油大学\s*\(\s*北京\s*\)\s*克拉玛依校区/u,
    name: "中国石油大学（北京）克拉玛依校区",
  },
  {
    pattern: /中国石油大学\s*\(\s*华东\s*\)/u,
    name: "中国石油大学（华东）",
  },
  {
    pattern: /中国石油大学\s*\(\s*北京\s*\)/u,
    name: "中国石油大学（北京）",
  },
  {
    pattern: /大连理工大学\s*(?:\(\s*盘锦校区\s*\)|盘锦校区)/u,
    name: "大连理工大学（盘锦校区）",
  },
  {
    pattern: /哈尔滨工业大学\s*(?:\(\s*威海校区\s*\)|威海校区)/u,
    name: "哈尔滨工业大学（威海校区）",
  },
];
const CATEGORY_WORDS = new RegExp(
  [
    "报名(?:表|信息)?",
    "参赛(?:队伍)?(?:信息)?",
    "registration",
    "edp",
    "海报",
    "poster",
    "宣传(?:视频|片)",
    "视频",
    "video",
    "中文版?",
    "英文版?",
    "english",
    "supplement(?:ary)?",
    "补充(?:文件|材料)?",
    "增补(?:文件|材料)?",
    "moc",
    "最终版",
    "定稿",
    "更新版",
    "新版",
    "第[一二三四五六七八九十0-9]+版",
    "v(?:ersion)?\\s*[0-9]+",
  ].join("|"),
  "giu",
);

function stemFromFilename(filename: string): string {
  return filename
    .normalize("NFKC")
    .replace(/^.*[\\/]/u, "")
    .replace(/\.(?:xlsx|xls|zip|7z|rar|ai|jpe?g|mp4)$/iu, "")
    .replace(/(?:（|\(|【|\x5B)\s*(?:第?[一二三四五六七八九十0-9]+版|最终版|定稿|更新版|新版|v(?:ersion)?\s*[0-9]+)\s*(?:）|\)|】|\x5D)/giu, " ")
    .replace(CATEGORY_WORDS, " ")
    .replace(/(?:19|20)\d{2}(?:[-_.年]\d{1,2})?(?:[-_.月]\d{1,2}日?)?/gu, " ")
    .replace(/[—–_-]+/gu, " ")
    .replace(/[，,、:：;；]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function schoolDisplayText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/^\d{1,4}\s*(?=[\p{Script=Han}A-Za-z])/u, "")
    .replace(/^(?:学校|院校|团队单位|参赛单位)\s*[:：]?\s*/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function isCampusQualifier(value: string): boolean {
  if (!value || value.length > 30 || NON_CAMPUS_QUALIFIER.test(value)) return false;
  return /校区/u.test(value) || /^[\p{Script=Han}A-Za-z0-9· -]{1,20}$/u.test(value);
}

/**
 * Keeps a real campus qualifier as part of the institution identity while
 * removing department/college text appended after a university name.
 *
 * Examples:
 * - 中国石油大学（北京） and 中国石油大学（华东） remain different schools.
 * - 合肥工业大学化学化工学院 becomes 合肥工业大学.
 */
export function normalizeCompetitionSchoolName(value: string): string {
  const normalized = schoolDisplayText(value);
  if (!normalized) return "";

  for (const known of KNOWN_CAMPUS_NAMES) {
    if (known.pattern.test(normalized)) return known.name;
  }

  const university = normalized.match(/([\p{Script=Han}A-Za-z0-9·＆&]+?大学)/u);
  const institution = university
    ?? normalized.match(/([\p{Script=Han}A-Za-z0-9·＆&]+?(?:职业技术学院|学院|研究院|学校|中学))/u);
  if (!institution?.[1]) return normalized;

  const base = institution[1].trim();
  const tail = normalized.slice((institution.index ?? 0) + institution[1].length);
  const parenthetical = tail.match(/^\s*\(\s*([^()]{1,30}?)\s*\)/u);
  if (parenthetical?.[1]) {
    const qualifier = parenthetical[1].replace(/\s+/gu, "").trim();
    if (isCampusQualifier(qualifier)) {
      const afterQualifier = tail.slice(parenthetical[0].length);
      const trailingCampus = afterQualifier.match(/^\s*([\p{Script=Han}A-Za-z0-9·]{1,30}校区)/u)?.[1];
      return `${base}（${qualifier}）${trailingCampus ?? ""}`;
    }
  }

  const trailingCampus = tail.match(/^\s*([\p{Script=Han}A-Za-z0-9·]{1,30}校区)/u)?.[1];
  return trailingCampus ? `${base}（${trailingCampus}）` : base;
}

function schoolIdentityKey(value: string): string {
  return normalizeCompetitionSchoolName(value)
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** Prefer a campus-qualified filename over an imprecise base-school field. */
export function preferDetailedCompetitionSchoolName(primary: string | null, candidates: string[]): string | null {
  let selected = primary ? normalizeCompetitionSchoolName(primary) : "";
  for (const candidate of candidates) {
    const normalized = normalizeCompetitionSchoolName(candidate);
    if (!normalized) continue;
    if (!selected) {
      selected = normalized;
      continue;
    }
    const selectedKey = schoolIdentityKey(selected);
    const candidateKey = schoolIdentityKey(normalized);
    const isMoreDetailedCampus = candidateKey.startsWith(selectedKey)
      && candidateKey.length > selectedKey.length
      && (/校区/u.test(normalized) || /（[^）]+）/u.test(normalized));
    if (isMoreDetailedCampus) selected = normalized;
  }
  return selected || null;
}

/**
 * Infers the school from the file name so manual uploads require only a file.
 * Files that cannot be identified are rejected with a rename hint instead of
 * silently assigning them to the wrong school.
 */
export function inferSchoolNameFromFilename(filename: string): string | null {
  const stem = stemFromFilename(filename);
  if (!stem || stem.length > 240) return null;

  const chunks = stem.split(/\s{1,}|[|]+/u).map((part) => part.trim()).filter(Boolean);
  const candidates = [stem, ...chunks];
  for (const candidate of candidates) {
    const chinese = normalizeCompetitionSchoolName(candidate);
    if (new RegExp(SCHOOL_SUFFIX, "u").test(chinese)) return chinese;
  }

  const englishPatterns = [
    /\b([A-Z][A-Za-z&.' -]{1,100}\s(?:University|College|Institute))\b/u,
    /\b(University\s+of\s+[A-Z][A-Za-z&.' -]{1,100})\b/u,
  ];
  for (const pattern of englishPatterns) {
    const match = stem.match(pattern);
    if (match?.[1]) return match[1].replace(/\s+/gu, " ").trim();
  }
  return null;
}

export function manualFileMetadata(filename: string, now = new Date()): ManualFileMetadata {
  const schoolName = inferSchoolNameFromFilename(filename);
  if (!schoolName) {
    throw new Error("无法从文件名识别学校；请将文件重命名为“学校名称-资料类型.扩展名”后重新选择。例：天津大学-报名表.xlsx。");
  }
  const submittedAt = now.toISOString();
  return {
    schoolName,
    submittedAt,
    submissionId: `manual-${now.getTime()}-${crypto.randomUUID()}`,
  };
}
