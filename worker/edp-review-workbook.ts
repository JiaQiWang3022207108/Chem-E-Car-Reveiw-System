import JSZip from "jszip";

export type WorkbookReviewStatus = "yes" | "no" | "not_applicable" | "needs_human";
export type WorkbookOverallStatus = "pending" | "passed" | "failed" | "needs_human";

export interface EdpReviewWorkbookItem {
  ruleId: string;
  worksheetName?: "1) EDP Cover Page" | "2) EDP Evaluation";
  row: number;
  status: WorkbookReviewStatus;
  comment: string;
  evidence?: readonly {
    documentRole: string;
    filename: string;
    page: number;
    excerpt: string;
  }[];
}

export interface EdpReviewWorkbookPayload {
  schoolName: string;
  competitionYear: string;
  submissionRound: 1 | 2 | 3 | 4 | 5;
  reviewedAt: string;
  overallStatus: WorkbookOverallStatus;
  workName?: string;
  instructorName?: string;
  instructorEmail?: string;
  safetyReviewerName: string;
  safetyReviewerEmail: string;
  expertMemberName: string;
  ruleFilename?: string;
  ruleVersion?: string;
  items: readonly EdpReviewWorkbookItem[];
}

const CHECKLIST_ROWS = Object.freeze([
  5, 6, 8, 9, 10, 11, 12, 13, 15, 16, 18, 19, 20, 21, 22, 23,
  24, 25, 26, 27, 29, 30, 31, 32, 34, 36, 37, 39, 40, 41, 43, 44,
]);

const COVER_VARIABLE_CELLS = Object.freeze([
  "A1", "E4", "E5", "E6", "E7", "E8", "E9", "E10", "E11", "C13",
  "C16", "D16", "C20", "D20", "C21", "D21", "C22", "D22", "C23",
  "C24", "D23", "C25", "C26", "C27",
]);

const FIRST_ROUND_MOC_COMMENT = "第1次 EDP 提交不要求 MOC 文件。";

export function reviewStatusLabel(status: WorkbookReviewStatus): "是" | "否" | "不适用" | "待人工确认" {
  if (status === "yes") return "是";
  if (status === "no") return "否";
  if (status === "not_applicable") return "不适用";
  return "待人工确认";
}

function overallLabel(status: WorkbookOverallStatus): "通过" | "未通过" | "待人工确认" {
  if (status === "passed") return "通过";
  if (status === "failed") return "未通过";
  return "待人工确认";
}

function overallCellStatus(status: WorkbookOverallStatus): WorkbookReviewStatus {
  if (status === "passed") return "yes";
  if (status === "failed") return "no";
  return "needs_human";
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

type CellValue = { type: "blank" } | { type: "string"; value: string } | { type: "number"; value: number };

function cellXml(reference: string, style: string | null, value: CellValue): string {
  const styleAttribute = style ? ` s="${style}"` : "";
  if (value.type === "blank" || (value.type === "string" && !value.value)) {
    return `<c r="${reference}"${styleAttribute}/>`;
  }
  if (value.type === "number") {
    return `<c r="${reference}"${styleAttribute} t="n"><v>${String(value.value)}</v></c>`;
  }
  return `<c r="${reference}"${styleAttribute} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value.value)}</t></is></c>`;
}

function replaceCell(xml: string, reference: string, value: CellValue): string {
  const cellStart = `<c(?=[^>]*\\br="${escapePattern(reference)}")[^>]*?`;
  const pattern = new RegExp(`(?:${cellStart}\\/>|${cellStart}>[\\s\\S]*?<\\/c>)`, "u");
  const existing = xml.match(pattern)?.[0];
  if (!existing) throw new Error(`EDP review template is missing styled cell ${reference}`);
  const style = existing.match(/\bs="([^"]+)"/u)?.[1] ?? null;
  return xml.replace(pattern, cellXml(reference, style, value));
}

function setString(xml: string, reference: string, value: string): string {
  return replaceCell(xml, reference, { type: "string", value });
}

function clearCell(xml: string, reference: string): string {
  return replaceCell(xml, reference, { type: "blank" });
}

function excelSerial(value: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error("reviewedAt must be a valid date");
  return time / 86_400_000 + 25_569;
}

function itemForRule(items: readonly EdpReviewWorkbookItem[], ruleId: string): EdpReviewWorkbookItem | null {
  return items.find((item) => item.ruleId === ruleId) ?? null;
}

function coverSummary(payload: EdpReviewWorkbookPayload): string {
  return `第${payload.submissionRound}次 EDP 审核：${overallLabel(payload.overallStatus)}`;
}

function overallComment(payload: EdpReviewWorkbookPayload): string {
  if (payload.overallStatus === "passed") return "全部审核项均已确认，依据当前 EDP 记录判定通过审查。";
  if (payload.overallStatus === "failed") return "审核中存在明确不符合项，请根据第二工作表的逐项意见修改。";
  return "尚有待人工确认的审核项，当前不能作出最终符合性结论。";
}

function mappedCoverItem(payload: EdpReviewWorkbookPayload, ruleId: string): EdpReviewWorkbookItem {
  return itemForRule(payload.items, ruleId) ?? {
    ruleId,
    row: 0,
    status: "needs_human",
    comment: "未找到足以自动判定的明确证据，请人工核对。",
  };
}

function firstEvidencePage(item: EdpReviewWorkbookItem): number {
  return item.evidence?.[0]?.page ?? Number.MAX_SAFE_INTEGER;
}

function sortedItems(items: readonly EdpReviewWorkbookItem[]): EdpReviewWorkbookItem[] {
  return [...items].sort((left, right) => firstEvidencePage(left) - firstEvidencePage(right)
    || left.ruleId.localeCompare(right.ruleId, "en"));
}

function aggregateStatus(items: readonly EdpReviewWorkbookItem[]): WorkbookReviewStatus {
  if (items.some(({ status }) => status === "no")) return "no";
  if (items.some(({ status }) => status === "needs_human")) return "needs_human";
  if (items.some(({ status }) => status === "yes")) return "yes";
  return "not_applicable";
}

function evidenceComment(item: EdpReviewWorkbookItem): string {
  const evidence = item.evidence?.[0];
  if (!evidence) return item.comment;
  const excerpt = normalizeWorkbookText(evidence.excerpt).slice(0, 180);
  const source = `${evidence.filename} 第${evidence.page}页`;
  return `${item.comment}（${source}${excerpt ? `；证据：“${excerpt}”` : ""}）`;
}

function normalizeWorkbookText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function combinedComments(items: readonly EdpReviewWorkbookItem[]): string {
  const comments = sortedItems(items).map(evidenceComment);
  if (comments.length <= 1) return comments[0] ?? "";
  return comments.map((comment) => `• ${comment}`).join("\n");
}

function coverAuditSummary(payload: EdpReviewWorkbookPayload): string {
  const source = `审核依据：${payload.ruleFilename || "内置 EDP 审核规则"}；规则版本：${payload.ruleVersion || "v1"}。`;
  const coverItems = payload.items.filter(({ worksheetName }) => worksheetName === "1) EDP Cover Page");
  const coverComments = combinedComments(coverItems);
  return [overallComment(payload), source, coverComments].filter(Boolean).join("\n");
}

function removeTemplateEmailHyperlinks(sheetXml: string, relationshipsXml: string): [string, string] {
  const relationshipIds = [...sheetXml.matchAll(/<hyperlink\b(?=[^>]*\bref="(?:E7|E9|E11)")(?=[^>]*\br:id="([^"]+)")[^>]*\/>/gu)]
    .map((match) => match[1]);
  const cleanedSheet = sheetXml.replace(/<hyperlink\b(?=[^>]*\bref="(?:E7|E9|E11)")[^>]*\/>/gu, "");
  let cleanedRelationships = relationshipsXml;
  for (const relationshipId of relationshipIds) {
    const pattern = new RegExp(`<Relationship\\b(?=[^>]*\\bId="${escapePattern(relationshipId)}")[^>]*\\/>`, "gu");
    cleanedRelationships = cleanedRelationships.replace(pattern, "");
  }
  return [cleanedSheet, cleanedRelationships];
}

function clearStaleSharedStrings(sharedStringsXml: string, worksheets: readonly string[]): string {
  // Clearing a visible cell does not remove its old value from sharedStrings.
  // Determine live references instead of embedding actual example identities in
  // source code or accidentally deleting a label that is still in use.
  const referenced = new Set<number>();
  for (const worksheet of worksheets) {
    for (const cell of worksheet.matchAll(/<c\b(?=[^>]*\bt="s")[^>]*?(?:\/>|>[\s\S]*?<\/c>)/gu)) {
      const index = cell[0].match(/<v>\s*(\d+)\s*<\/v>/u)?.[1];
      if (index !== undefined) referenced.add(Number(index));
    }
  }
  let index = 0;
  return sharedStringsXml.replace(/<si\b[^>]*?(?:\/>|>[\s\S]*?<\/si>)/gu,
    (entry) => referenced.has(index++) ? entry : "<si><t></t></si>");
}

export async function buildEdpReviewWorkbook(
  templateBytes: ArrayBuffer | Uint8Array,
  payload: EdpReviewWorkbookPayload,
): Promise<Uint8Array> {
  const archive = await JSZip.loadAsync(templateBytes, { checkCRC32: true });
  const coverFile = archive.file("xl/worksheets/sheet1.xml");
  const evaluationFile = archive.file("xl/worksheets/sheet2.xml");
  const coverRelationshipsFile = archive.file("xl/worksheets/_rels/sheet1.xml.rels");
  if (!coverFile || !evaluationFile) throw new Error("EDP review template must contain both worksheet XML files");
  let coverXml = await coverFile.async("string");
  let evaluationXml = await evaluationFile.async("string");

  for (const reference of COVER_VARIABLE_CELLS) coverXml = clearCell(coverXml, reference);
  for (const row of CHECKLIST_ROWS) {
    evaluationXml = clearCell(evaluationXml, `B${row}`);
    evaluationXml = clearCell(evaluationXml, `D${row}`);
  }

  coverXml = setString(coverXml, "A1", `${payload.competitionYear}中国大学生Chem-E-Car竞赛®`);
  coverXml = setString(coverXml, "E4", payload.schoolName);
  coverXml = setString(coverXml, "E5", payload.workName ?? "");
  coverXml = setString(coverXml, "E6", payload.instructorName ?? "");
  coverXml = setString(coverXml, "E7", payload.instructorEmail ?? "");
  coverXml = setString(coverXml, "E8", payload.safetyReviewerName);
  coverXml = setString(coverXml, "E9", payload.safetyReviewerEmail);
  coverXml = setString(coverXml, "E10", payload.expertMemberName);
  coverXml = clearCell(coverXml, "E11");
  coverXml = setString(coverXml, "C13", coverSummary(payload));
  coverXml = setString(coverXml, "C16", payload.safetyReviewerName);
  coverXml = setString(coverXml, "D16", coverAuditSummary(payload));

  const certification = mappedCoverItem(payload, "certification_signatures");
  const moc = payload.submissionRound === 1
    ? { ruleId: "moc", row: 34, status: "not_applicable" as const, comment: FIRST_ROUND_MOC_COMMENT }
    : mappedCoverItem(payload, "moc");
  coverXml = setString(coverXml, "C20", reviewStatusLabel(certification.status));
  coverXml = setString(coverXml, "D20", certification.comment);
  coverXml = setString(coverXml, "C21", reviewStatusLabel(certification.status));
  coverXml = setString(coverXml, "D21", certification.comment);
  coverXml = setString(coverXml, "C22", reviewStatusLabel(moc.status));
  coverXml = setString(coverXml, "D22", moc.comment);
  coverXml = setString(coverXml, "C23", reviewStatusLabel(overallCellStatus(payload.overallStatus)));
  coverXml = setString(coverXml, "C24", reviewStatusLabel(overallCellStatus(payload.overallStatus)));
  coverXml = setString(coverXml, "D23", overallComment(payload));
  coverXml = setString(coverXml, "C25", payload.safetyReviewerName);
  coverXml = setString(coverXml, "C26", payload.expertMemberName);
  coverXml = replaceCell(coverXml, "C27", { type: "number", value: excelSerial(payload.reviewedAt) });

  const itemsByRow = new Map<number, EdpReviewWorkbookItem[]>();
  for (const item of payload.items) {
    if (item.worksheetName === "1) EDP Cover Page") continue;
    const rowItems = itemsByRow.get(item.row) ?? [];
    rowItems.push(item);
    itemsByRow.set(item.row, rowItems);
  }
  for (const row of CHECKLIST_ROWS) {
    if (payload.submissionRound === 1 && row === 34) {
      evaluationXml = setString(evaluationXml, "B34", reviewStatusLabel("not_applicable"));
      evaluationXml = setString(evaluationXml, "D34", FIRST_ROUND_MOC_COMMENT);
      continue;
    }
    const rowItems = itemsByRow.get(row) ?? [];
    const status = rowItems.length ? aggregateStatus(rowItems) : "needs_human";
    const comment = rowItems.length ? combinedComments(rowItems) : "尚未完成自动审核，请人工核对。";
    evaluationXml = setString(evaluationXml, `B${row}`, reviewStatusLabel(status));
    evaluationXml = setString(evaluationXml, `D${row}`, comment);
  }

  archive.file("xl/worksheets/sheet1.xml", coverXml);
  archive.file("xl/worksheets/sheet2.xml", evaluationXml);
  if (coverRelationshipsFile) {
    const relationshipsXml = await coverRelationshipsFile.async("string");
    const [cleanedCover, cleanedRelationships] = removeTemplateEmailHyperlinks(coverXml, relationshipsXml);
    archive.file("xl/worksheets/sheet1.xml", cleanedCover);
    archive.file("xl/worksheets/_rels/sheet1.xml.rels", cleanedRelationships);
  }
  const sharedStringsFile = archive.file("xl/sharedStrings.xml");
  if (sharedStringsFile) {
    const worksheets = await Promise.all(Object.keys(archive.files)
      .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/u.test(name))
      .map((name) => archive.file(name)!.async("string")));
    archive.file("xl/sharedStrings.xml", clearStaleSharedStrings(await sharedStringsFile.async("string"), worksheets));
  }
  return archive.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
