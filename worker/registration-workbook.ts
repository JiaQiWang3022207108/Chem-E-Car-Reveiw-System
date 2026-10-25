import JSZip from "jszip";
import * as XLSX from "xlsx";
import { normalizeCompetitionSchoolName } from "./file-metadata";

export interface RegistrationSummary {
  schoolName: string;
  teamName: string;
  teamEmail: string;
  leaderName: string;
  leaderPhone: string;
  videoCompetition: string;
  attendanceMode: string;
}

export interface RegistrationAssessment {
  qualified: boolean;
  teacherCount: number;
  studentCount: number;
  reasons: string[];
  summary: RegistrationSummary;
}

export class RegistrationWorkbookError extends Error {
  constructor(
    public readonly code: "registration_template_unrecognized" | "master_template_unrecognized" | "registration_school_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "RegistrationWorkbookError";
  }
}

type CellValue = string | number | boolean | Date | null;
type SheetMatrix = { name: string; sheet: XLSX.WorkSheet; rows: CellValue[][] };

// Competition registration forms contain only a few dozen meaningful rows.
// Some Excel editors nevertheless leave a value or style on row 1,048,576,
// expanding !ref to the whole worksheet.  Limiting the analysis window keeps
// that workbook metadata from turning into a million empty participant rows,
// while still leaving ample room for the master statistics workbook.
const MAX_ANALYZED_WORKBOOK_ROWS = 10_000;

interface MasterSheet {
  name: string;
  sheet: XLSX.WorkSheet;
  headerRow: number;
  lastRow: number;
  columns: {
    country?: number;
    school: number;
    teamName: number;
    teamEmail: number;
    leaderName: number;
    leaderPhone: number;
    videoCompetition: number;
    attendanceMode: number;
  };
  rows: CellValue[][];
}

function displayText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value).normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function compactLabel(value: unknown): string {
  return displayText(value).toLocaleLowerCase("zh-CN").replace(/[\s\p{P}\p{S}]+/gu, "");
}

function schoolKey(value: string): string {
  return compactLabel(normalizeCompetitionSchoolName(value));
}

function workbookMatrices(workbook: XLSX.WorkBook): SheetMatrix[] {
  return workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const decodedRange = XLSX.utils.decode_range(sheet["!ref"] || "A1:A1");
    decodedRange.e.r = Math.min(decodedRange.e.r, MAX_ANALYZED_WORKBOOK_ROWS - 1);
    const rows = XLSX.utils.sheet_to_json<CellValue[]>(sheet, {
      header: 1,
      defval: null,
      raw: false,
      blankrows: true,
      range: XLSX.utils.encode_range(decodedRange),
    });
    return { name, sheet, rows };
  });
}

function valueAfterLabel(rows: CellValue[][], labels: RegExp[]): string {
  for (const row of rows) {
    for (let column = 0; column < row.length; column += 1) {
      const label = compactLabel(row[column]);
      if (!label || !labels.some((pattern) => pattern.test(label))) continue;
      for (let candidate = column + 1; candidate < row.length; candidate += 1) {
        const value = displayText(row[candidate]);
        if (value) return value;
      }
    }
  }
  return "";
}

function preferredSheet(sheets: SheetMatrix[], namePattern: RegExp, contentPattern?: RegExp): SheetMatrix | null {
  const byName = sheets.find((entry) => namePattern.test(entry.name));
  if (byName) return byName;
  if (!contentPattern) return null;
  return sheets.find((entry) => entry.rows.some((row) => row.some((cell) => contentPattern.test(compactLabel(cell))))) ?? null;
}

function leaderFromMembers(sheet: SheetMatrix): { name: string; phone: string } {
  for (let rowIndex = 0; rowIndex < sheet.rows.length; rowIndex += 1) {
    const labels = sheet.rows[rowIndex].map(compactLabel);
    const nameColumn = labels.findIndex((label) => /团队成员姓名|学生姓名|队员姓名|成员姓名/u.test(label));
    if (nameColumn < 0) continue;
    const phoneColumn = labels.findIndex((label) => /联系电话|手机号|手机号码|电话/u.test(label));
    for (let candidate = rowIndex + 1; candidate < sheet.rows.length; candidate += 1) {
      const name = displayText(sheet.rows[candidate]?.[nameColumn]);
      if (!name || /姓名/u.test(name)) continue;
      return { name, phone: phoneColumn >= 0 ? displayText(sheet.rows[candidate]?.[phoneColumn]) : "" };
    }
  }
  return { name: "", phone: "" };
}

type RosterColumn = {
  label: string;
  patterns: RegExp[];
};

function rosterAssessment(
  sheet: SheetMatrix | null,
  tableLabel: string,
  columns: RosterColumn[],
): { count: number; reasons: string[] } {
  if (!sheet) return { count: 0, reasons: [`缺少${tableLabel}。`] };
  let headerRow = -1;
  let positions: number[] = [];
  for (let rowIndex = 0; rowIndex < sheet.rows.length; rowIndex += 1) {
    const labels = sheet.rows[rowIndex].map(compactLabel);
    const candidate = columns.map((column) => labels.findIndex((label) => column.patterns.some((pattern) => pattern.test(label))));
    if (candidate.every((position) => position >= 0)) {
      headerRow = rowIndex;
      positions = candidate;
      break;
    }
  }
  if (headerRow < 0) return { count: 0, reasons: [`${tableLabel}缺少完整的人员信息表头。`] };

  const reasons: string[] = [];
  let count = 0;
  const headerLabels = sheet.rows[headerRow].map(compactLabel);
  const sequenceColumn = headerLabels.findIndex((label) => /^(?:序号|编号|no)$/iu.test(label));
  for (let rowIndex = headerRow + 1; rowIndex < sheet.rows.length; rowIndex += 1) {
    const values = positions.map((position) => displayText(sheet.rows[rowIndex]?.[position]));
    const sequence = sequenceColumn >= 0 ? displayText(sheet.rows[rowIndex]?.[sequenceColumn]) : "";
    const normalizedSequence = sequence.replace(/[.．、]/gu, "");
    const sequenceNumber = /^\d{1,3}$/u.test(normalizedSequence) ? Number(normalizedSequence) : 0;
    const filledRequiredFields = values.filter(Boolean).length;
    // A real roster row has a plausible sequence number, a name (the first
    // required column), or at least two substantive fields.  An isolated value
    // such as the stray gender marker found at Excel's last row is not a person.
    const effectiveRow = (sequenceNumber >= 1 && sequenceNumber <= 999)
      || Boolean(values[0])
      || filledRequiredFields >= 2;
    if (!effectiveRow) continue;
    count += 1;
    for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
      if (!values[columnIndex]) reasons.push(`${tableLabel}第${rowIndex + 1}行缺少${columns[columnIndex].label}。`);
    }
  }
  return { count, reasons };
}

function requiredLabeledValue(
  sheet: SheetMatrix | null,
  tableLabel: string,
  fieldLabel: string,
  patterns: RegExp[],
  reasons: string[],
): string {
  if (!sheet) return "";
  const value = valueAfterLabel(sheet.rows, patterns);
  if (!value) reasons.push(`${tableLabel}未填写${fieldLabel}。`);
  return value;
}

function sameText(left: string, right: string): boolean {
  return compactLabel(left) === compactLabel(right);
}

export function assessRegistrationWorkbook(
  bytes: ArrayBuffer | Uint8Array,
  expectedSchoolName: string,
): RegistrationAssessment {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(bytes, { type: "array", cellDates: true, cellStyles: true, cellNF: true });
  } catch {
    throw new RegistrationWorkbookError("registration_template_unrecognized", "报名表不是可读取的 .xlsx 工作簿。" );
  }
  const sheets = workbookMatrices(workbook);
  const teacherSheet = preferredSheet(sheets, /表?1.*指导教师|指导教师/u, /指导教师姓名/u);
  const memberSheet = preferredSheet(sheets, /表?2.*团队成员|团队成员|学生名单|队员/u, /团队成员姓名|学生姓名|队员姓名/u);
  if (!teacherSheet && !memberSheet) {
    throw new RegistrationWorkbookError("registration_template_unrecognized", "报名表中未找到“表1-指导教师”或“表2-团队成员”。" );
  }
  const videoSheet = preferredSheet(sheets, /视频/u, /是否报名视频竞赛/u);
  const reasons: string[] = [];

  const teacherRoster = rosterAssessment(teacherSheet, "表1-指导教师", [
    { label: "指导教师姓名", patterns: [/指导教师姓名|教师姓名/u] },
    { label: "联系电话", patterns: [/联系电话|手机号|手机号码|电话/u] },
    { label: "性别", patterns: [/^性别$/u] },
    { label: "E-mail", patterns: [/email|邮箱/u] },
  ]);
  const memberRoster = rosterAssessment(memberSheet, "表2-团队成员", [
    { label: "团队成员姓名", patterns: [/团队成员姓名|学生姓名|队员姓名|成员姓名/u] },
    { label: "联系电话", patterns: [/联系电话|手机号|手机号码|电话/u] },
    { label: "性别", patterns: [/^性别$/u] },
    { label: "E-mail", patterns: [/email|邮箱/u] },
    { label: "年级", patterns: [/年级/u] },
  ]);
  reasons.push(...teacherRoster.reasons, ...memberRoster.reasons);
  if (teacherRoster.count === 0) reasons.push("表1-指导教师未填写指导教师信息。");
  if (teacherRoster.count > 5) reasons.push(`指导教师人数为${teacherRoster.count}人，不能超过5人。`);
  if (memberRoster.count < 5 || memberRoster.count > 15) {
    reasons.push(`学生人数为${memberRoster.count}人，必须不少于5人且不超过15人。`);
  }

  const teacherTeamName = requiredLabeledValue(teacherSheet, "表1-指导教师", "团队名称", [/^团队名称$/u, /^队名$/u], reasons);
  const teacherSchool = requiredLabeledValue(teacherSheet, "表1-指导教师", "团队单位", [/^团队单位$/u, /^学校(?:名称)?$/u, /^参赛单位$/u], reasons);
  const teacherEmail = requiredLabeledValue(teacherSheet, "表1-指导教师", "团队联系邮箱", [/^团队联系邮箱$/u, /^团队联系方式邮箱$/u, /^联系邮箱$/u], reasons);
  const memberTeamName = requiredLabeledValue(memberSheet, "表2-团队成员", "团队名称", [/^团队名称$/u, /^队名$/u], reasons);
  const memberSchool = requiredLabeledValue(memberSheet, "表2-团队成员", "团队单位", [/^团队单位$/u, /^学校(?:名称)?$/u, /^参赛单位$/u], reasons);
  const memberEmail = requiredLabeledValue(memberSheet, "表2-团队成员", "团队联系邮箱", [/^团队联系邮箱$/u, /^团队联系方式邮箱$/u, /^联系邮箱$/u], reasons);
  const attendanceMode = requiredLabeledValue(memberSheet, "表2-团队成员", "参赛方式（线上/线下）", [/^参赛方式线上线下$/u, /^线上线下$/u, /^参赛方式$/u], reasons);

  if (teacherTeamName && memberTeamName && !sameText(teacherTeamName, memberTeamName)) reasons.push("表1与表2填写的团队名称不一致。");
  if (teacherEmail && memberEmail && !sameText(teacherEmail, memberEmail)) reasons.push("表1与表2填写的团队联系邮箱不一致。");
  const normalizedTeacherSchool = normalizeCompetitionSchoolName(teacherSchool);
  const normalizedMemberSchool = normalizeCompetitionSchoolName(memberSchool);
  if (normalizedTeacherSchool && normalizedMemberSchool && schoolKey(normalizedTeacherSchool) !== schoolKey(normalizedMemberSchool)) {
    reasons.push("表1与表2填写的团队单位不一致。");
  }
  const normalizedExpectedSchool = normalizeCompetitionSchoolName(expectedSchoolName);
  const workbookSchoolName = normalizedMemberSchool || normalizedTeacherSchool;
  if (workbookSchoolName && schoolKey(workbookSchoolName) !== schoolKey(normalizedExpectedSchool)) {
    throw new RegistrationWorkbookError(
      "registration_school_mismatch",
      `文件名或凡科字段中的学校“${normalizedExpectedSchool}”与报名表内团队单位“${workbookSchoolName}”不一致。`,
    );
  }
  const leader = memberSheet ? leaderFromMembers(memberSheet) : { name: "", phone: "" };
  const videoCompetition = valueAfterLabel(videoSheet?.rows ?? [], [/^是否报名视频竞赛$/u, /^视频竞赛$/u]);
  return {
    qualified: reasons.length === 0,
    teacherCount: teacherRoster.count,
    studentCount: memberRoster.count,
    reasons: Array.from(new Set(reasons)),
    summary: {
      schoolName: workbookSchoolName || normalizedExpectedSchool,
      teamName: memberTeamName || teacherTeamName,
      teamEmail: memberEmail || teacherEmail,
      leaderName: leader.name,
      leaderPhone: leader.phone,
      videoCompetition,
      attendanceMode,
    },
  };
}

export function extractRegistrationSummary(bytes: ArrayBuffer | Uint8Array): RegistrationSummary {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(bytes, { type: "array", cellDates: true, cellStyles: true, cellNF: true });
  } catch {
    throw new RegistrationWorkbookError("registration_template_unrecognized", "报名表不是可读取的 .xlsx 工作簿。" );
  }
  const sheets = workbookMatrices(workbook);
  const memberSheet = preferredSheet(sheets, /团队成员|学生名单|队员/u, /团队成员姓名|学生姓名|队员姓名/u);
  if (!memberSheet) {
    throw new RegistrationWorkbookError("registration_template_unrecognized", "报名表中未找到“团队成员”工作表或学生名单。" );
  }
  const videoSheet = preferredSheet(sheets, /视频/u, /是否报名视频竞赛/u);
  const sharedRows = [memberSheet, ...sheets.filter((entry) => entry !== memberSheet)].flatMap((entry) => entry.rows);
  const leader = leaderFromMembers(memberSheet);
  const rawSchoolName = valueAfterLabel(sharedRows, [/^团队单位$/u, /^学校(?:名称)?$/u, /^参赛单位$/u]);
  const schoolName = normalizeCompetitionSchoolName(rawSchoolName);
  const teamName = valueAfterLabel(sharedRows, [/^团队名称$/u, /^队名$/u]);
  const teamEmail = valueAfterLabel(sharedRows, [/^团队联系邮箱$/u, /^团队联系方式邮箱$/u, /^联系邮箱$/u]);
  const attendanceMode = valueAfterLabel(memberSheet.rows, [/^参赛方式线上线下$/u, /^线上线下$/u, /^参赛方式$/u]);
  const videoCompetition = valueAfterLabel(videoSheet?.rows ?? sharedRows, [/^是否报名视频竞赛$/u, /^视频竞赛$/u]);
  if (!schoolName || !teamName || !teamEmail || !leader.name) {
    throw new RegistrationWorkbookError(
      "registration_template_unrecognized",
      "报名表缺少团队单位、团队名称、团队联系邮箱或学生名单第一行的队长信息。",
    );
  }
  return {
    schoolName,
    teamName,
    teamEmail,
    leaderName: leader.name,
    leaderPhone: leader.phone,
    videoCompetition,
    attendanceMode,
  };
}

function masterHeader(rows: CellValue[][]): { headerRow: number; columns: MasterSheet["columns"] } | null {
  for (let rowIndex = 0; rowIndex < Math.min(rows.length, 20); rowIndex += 1) {
    const labels = rows[rowIndex].map(compactLabel);
    const find = (patterns: RegExp[]) => labels.findIndex((label) => patterns.some((pattern) => pattern.test(label)));
    const school = find([/^学校$/u, /^团队单位$/u]);
    const teamName = find([/^队名$/u, /^团队名称$/u]);
    const teamEmail = find([/^团队联系方式邮箱$/u, /^团队联系邮箱$/u, /^联系邮箱$/u]);
    const leaderName = find([/^负责人$/u, /^队长$/u, /^负责人姓名$/u]);
    const leaderPhone = find([/^负责人电话$/u, /^队长电话$/u, /^负责人联系电话$/u]);
    const videoCompetition = find([/^是否报名视频竞赛$/u, /^视频竞赛$/u]);
    const attendanceMode = find([/^线上线下$/u, /^参赛方式$/u, /^参赛方式线上线下$/u]);
    if ([school, teamName, teamEmail, leaderName, leaderPhone, videoCompetition, attendanceMode].some((value) => value < 0)) continue;
    const country = find([/^国家$/u, /^国家地区$/u]);
    return {
      headerRow: rowIndex,
      columns: {
        ...(country >= 0 ? { country } : {}),
        school,
        teamName,
        teamEmail,
        leaderName,
        leaderPhone,
        videoCompetition,
        attendanceMode,
      },
    };
  }
  return null;
}

function masterSheets(workbook: XLSX.WorkBook): MasterSheet[] {
  return workbookMatrices(workbook).flatMap((entry) => {
    const header = masterHeader(entry.rows);
    if (!header) return [];
    let lastRow = entry.rows.length - 1;
    while (lastRow > header.headerRow && entry.rows[lastRow].every((cell) => !displayText(cell))) lastRow -= 1;
    return [{
      name: entry.name,
      sheet: entry.sheet,
      headerRow: header.headerRow,
      lastRow,
      columns: header.columns,
      rows: entry.rows,
    }];
  });
}

function escapeXmlText(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/gu, "&quot;").replace(/'/gu, "&apos;");
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&amp;/gu, "&");
}

function xmlAttribute(tag: string, name: string): string | null {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = tag.match(new RegExp(`${escapedName}=(?:"([^"]*)"|'([^']*)')`, "u"));
  return match ? decodeXml(match[1] ?? match[2] ?? "") : null;
}

function replaceXmlAttribute(tag: string, name: string, value: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`(${escapedName}=)(?:"[^"]*"|'[^']*')`, "u");
  if (pattern.test(tag)) return tag.replace(pattern, `$1"${escapeXmlAttribute(value)}"`);
  return tag.replace(/\s*\/>$/u, ` ${name}="${escapeXmlAttribute(value)}"/>`);
}

function relationshipPartForSheet(sheetPart: string): string {
  const slash = sheetPart.lastIndexOf("/");
  return `${sheetPart.slice(0, slash)}/_rels/${sheetPart.slice(slash + 1)}.rels`;
}

async function worksheetPart(zip: JSZip, sheetName: string): Promise<string> {
  const workbookXml = await zip.file("xl/workbook.xml")?.async("string");
  const relationshipsXml = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
  if (!workbookXml || !relationshipsXml) {
    throw new RegistrationWorkbookError("master_template_unrecognized", "唯一统计表缺少工作簿关系信息。" );
  }
  const sheetTag = (workbookXml.match(/<sheet\b[^>]*\/?\s*>/gu) ?? [])
    .find((tag) => xmlAttribute(tag, "name") === sheetName);
  const relationshipId = sheetTag ? xmlAttribute(sheetTag, "r:id") : null;
  if (!relationshipId) {
    throw new RegistrationWorkbookError("master_template_unrecognized", `唯一统计表中无法定位“${sheetName}”工作表。` );
  }
  const relationshipTag = (relationshipsXml.match(/<Relationship\b[^>]*\/?\s*>/gu) ?? [])
    .find((tag) => xmlAttribute(tag, "Id") === relationshipId);
  const target = relationshipTag ? xmlAttribute(relationshipTag, "Target") : null;
  if (!target) {
    throw new RegistrationWorkbookError("master_template_unrecognized", `唯一统计表中“${sheetName}”工作表关系无效。` );
  }
  const normalized = target.replace(/^\//u, "").replace(/^xl\//u, "");
  return `xl/${normalized}`;
}

function cellPattern(address: string): RegExp {
  const escaped = address.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`<c\\b(?=[^>]*\\br=(?:"${escaped}"|'${escaped}'))[^>]*(?:\\/>|>[\\s\\S]*?<\\/c>)`, "u");
}

function rowPattern(rowNumber: number): RegExp {
  return new RegExp(`<row\\b(?=[^>]*\\br=(?:"${rowNumber}"|'${rowNumber}'))[^>]*>[\\s\\S]*?<\\/row>`, "u");
}

function styleAttribute(sheetXml: string, address: string, templateAddress: string): string {
  const cell = sheetXml.match(cellPattern(address))?.[0] ?? sheetXml.match(cellPattern(templateAddress))?.[0];
  const style = cell ? xmlAttribute(cell, "s") : null;
  return style === null ? "" : ` s="${escapeXmlAttribute(style)}"`;
}

function ensureRow(sheetXml: string, rowNumber: number, templateRowNumber: number): string {
  if (rowPattern(rowNumber).test(sheetXml)) return sheetXml;
  const template = sheetXml.match(rowPattern(templateRowNumber))?.[0];
  const templateOpen = template?.match(/^<row\b[^>]*>/u)?.[0];
  let open = templateOpen ? replaceXmlAttribute(templateOpen.replace(/>$/u, "/>"), "r", String(rowNumber)).replace(/\/>$/u, ">") : `<row r="${rowNumber}">`;
  open = open.replace(/\bspans=(?:"[^"]*"|'[^']*')/u, (match) => match);
  return sheetXml.replace("</sheetData>", `${open}</row></sheetData>`);
}

function setInlineStringCell(sheetXml: string, rowIndex: number, columnIndex: number, value: string): string {
  const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
  const templateAddress = XLSX.utils.encode_cell({ r: Math.max(0, rowIndex - 1), c: columnIndex });
  const cell = `<c r="${address}"${styleAttribute(sheetXml, address, templateAddress)} t="inlineStr"><is><t>${escapeXmlText(value)}</t></is></c>`;
  const existingPattern = cellPattern(address);
  if (existingPattern.test(sheetXml)) return sheetXml.replace(existingPattern, cell);

  const rowNumber = rowIndex + 1;
  const rowMatch = sheetXml.match(rowPattern(rowNumber));
  if (!rowMatch) throw new RegistrationWorkbookError("master_template_unrecognized", "唯一统计表无法创建目标数据行。" );
  const targetColumn = XLSX.utils.decode_cell(address).c;
  const existingCells = rowMatch[0].match(/<c\b[^>]*(?:\/>|>[\s\S]*?<\/c>)/gu) ?? [];
  const nextCell = existingCells.find((candidate) => {
    const ref = xmlAttribute(candidate, "r");
    return ref ? XLSX.utils.decode_cell(ref).c > targetColumn : false;
  });
  const updatedRow = nextCell
    ? rowMatch[0].replace(nextCell, `${cell}${nextCell}`)
    : rowMatch[0].replace("</row>", `${cell}</row>`);
  return sheetXml.replace(rowMatch[0], updatedRow);
}

function updateDimension(sheetXml: string, rowIndex: number, maximumColumn: number): string {
  return sheetXml.replace(/<dimension\b[^>]*\bref=(?:"([^"]+)"|'([^']+)')[^>]*\/>/u, (tag, doubleQuoted: string, singleQuoted: string) => {
    const current = XLSX.utils.decode_range(doubleQuoted ?? singleQuoted);
    current.e.r = Math.max(current.e.r, rowIndex);
    current.e.c = Math.max(current.e.c, maximumColumn);
    return replaceXmlAttribute(tag, "ref", XLSX.utils.encode_range(current));
  });
}

function updateEmailHyperlink(
  sheetXml: string,
  relationshipsXml: string | null,
  address: string,
  email: string,
): { sheetXml: string; relationshipsXml: string } {
  let rels = relationshipsXml ?? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  const hyperlinkTag = (sheetXml.match(/<hyperlink\b[^>]*\/>/gu) ?? [])
    .find((tag) => xmlAttribute(tag, "ref") === address);
  let relationshipId = hyperlinkTag ? xmlAttribute(hyperlinkTag, "r:id") : null;
  const relationshipTags = rels.match(/<Relationship\b[^>]*\/>/gu) ?? [];
  let relationshipTag = relationshipId
    ? relationshipTags.find((tag) => xmlAttribute(tag, "Id") === relationshipId)
    : undefined;

  if (!relationshipId || !relationshipTag) {
    const maximum = relationshipTags.reduce((current, tag) => {
      const id = xmlAttribute(tag, "Id")?.match(/^rId(\d+)$/u)?.[1];
      return id ? Math.max(current, Number(id)) : current;
    }, 0);
    relationshipId = `rId${maximum + 1}`;
    relationshipTag = `<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="mailto:${escapeXmlAttribute(email)}" TargetMode="External"/>`;
    rels = rels.replace("</Relationships>", `${relationshipTag}</Relationships>`);
  } else {
    const updatedRelationship = replaceXmlAttribute(relationshipTag, "Target", `mailto:${email}`);
    rels = rels.replace(relationshipTag, updatedRelationship);
  }

  let updatedHyperlink = hyperlinkTag ?? `<hyperlink ref="${address}" r:id="${relationshipId}" display="${escapeXmlAttribute(email)}"/>`;
  updatedHyperlink = replaceXmlAttribute(updatedHyperlink, "r:id", relationshipId);
  updatedHyperlink = replaceXmlAttribute(updatedHyperlink, "display", email);
  if (hyperlinkTag) sheetXml = sheetXml.replace(hyperlinkTag, updatedHyperlink);
  else if (sheetXml.includes("</hyperlinks>")) sheetXml = sheetXml.replace("</hyperlinks>", `${updatedHyperlink}</hyperlinks>`);
  else {
    const insertionPoint = sheetXml.includes("<pageMargins") ? "<pageMargins" : "</worksheet>";
    sheetXml = sheetXml.replace(insertionPoint, `<hyperlinks>${updatedHyperlink}</hyperlinks>${insertionPoint}`);
  }
  return { sheetXml, relationshipsXml: rels };
}

async function patchMasterArchive(
  masterBytes: ArrayBuffer | Uint8Array,
  sheetName: string,
  rowIndex: number,
  appended: boolean,
  columns: MasterSheet["columns"],
  summary: RegistrationSummary,
): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(masterBytes);
  const sheetPart = await worksheetPart(zip, sheetName);
  const sheetFile = zip.file(sheetPart);
  if (!sheetFile) throw new RegistrationWorkbookError("master_template_unrecognized", `唯一统计表缺少“${sheetName}”工作表内容。` );
  let sheetXml = await sheetFile.async("string");
  if (appended) sheetXml = ensureRow(sheetXml, rowIndex + 1, rowIndex);

  const values = new Map<number, string>([
    [columns.school, summary.schoolName],
    [columns.teamName, summary.teamName],
    [columns.teamEmail, summary.teamEmail],
    [columns.leaderName, summary.leaderName],
    [columns.leaderPhone, summary.leaderPhone],
    [columns.videoCompetition, summary.videoCompetition],
    [columns.attendanceMode, summary.attendanceMode],
  ]);
  if (appended && columns.country !== undefined) values.set(columns.country, "");
  for (const [column, value] of [...values].sort(([left], [right]) => left - right)) {
    sheetXml = setInlineStringCell(sheetXml, rowIndex, column, value);
  }

  const maximumColumn = Math.max(...Object.values(columns).filter((value): value is number => typeof value === "number"));
  sheetXml = updateDimension(sheetXml, rowIndex, maximumColumn);
  const relationshipsPart = relationshipPartForSheet(sheetPart);
  const relationshipsXml = await zip.file(relationshipsPart)?.async("string") ?? null;
  const emailAddress = XLSX.utils.encode_cell({ r: rowIndex, c: columns.teamEmail });
  const linked = updateEmailHyperlink(sheetXml, relationshipsXml, emailAddress, summary.teamEmail);
  zip.file(sheetPart, linked.sheetXml);
  zip.file(relationshipsPart, linked.relationshipsXml);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

function equivalentSchool(expected: string, actual: string): boolean {
  return schoolKey(expected) === schoolKey(actual);
}

export function validateRegistrationWorkbook(
  registrationBytes: ArrayBuffer | Uint8Array,
  expectedSchoolName: string,
): RegistrationSummary {
  const summary = extractRegistrationSummary(registrationBytes);
  if (!equivalentSchool(expectedSchoolName, summary.schoolName)) {
    throw new RegistrationWorkbookError(
      "registration_school_mismatch",
      `文件名或凡科字段中的学校“${expectedSchoolName}”与报名表内团队单位“${summary.schoolName}”不一致。`,
    );
  }
  return summary;
}

export async function updateMasterWorkbook(
  masterBytes: ArrayBuffer | Uint8Array,
  registrationBytes: ArrayBuffer | Uint8Array,
  expectedSchoolName: string,
): Promise<{ bytes: Uint8Array; summary: RegistrationSummary; sheetName: string; rowNumber: number; appended: boolean }> {
  const summary = validateRegistrationWorkbook(registrationBytes, expectedSchoolName);

  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(masterBytes, { type: "array", cellDates: true, cellStyles: true, cellNF: true, bookFiles: true });
  } catch {
    throw new RegistrationWorkbookError("master_template_unrecognized", "唯一统计表不是可读取的 .xlsx 工作簿。" );
  }
  const sheets = masterSheets(workbook);
  if (!sheets.length) {
    throw new RegistrationWorkbookError(
      "master_template_unrecognized",
      "唯一统计表中未找到学校、队名、团队邮箱、负责人、电话、视频竞赛和线上/线下题头。",
    );
  }

  let target: MasterSheet | undefined;
  let targetRow = -1;
  for (const sheet of sheets) {
    for (let row = sheet.headerRow + 1; row <= sheet.lastRow; row += 1) {
      if (equivalentSchool(displayText(sheet.rows[row]?.[sheet.columns.school]), summary.schoolName)) {
        target = sheet;
        targetRow = row;
        break;
      }
    }
    if (target) break;
  }

  const appended = !target;
  if (!target) {
    const hasHan = /\p{Script=Han}/u.test(summary.schoolName);
    target = sheets.find((sheet) => hasHan ? sheet.columns.country === undefined : sheet.columns.country !== undefined)
      ?? sheets[0];
    targetRow = target.lastRow + 1;
  }
  const output = await patchMasterArchive(masterBytes, target.name, targetRow, appended, target.columns, summary);
  return {
    bytes: output,
    summary,
    sheetName: target.name,
    rowNumber: targetRow + 1,
    appended,
  };
}
