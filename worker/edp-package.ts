import {
  openEdpArchiveCore,
  sniffEdpArchiveFormat,
  type EdpArchiveEntry,
  type EdpArchiveFormat,
  type OpenedEdpArchive,
} from "./edp-archive-core";
import { loadPdfJs } from "./pdf-runtime";
import { expectedPdfCount, packageIssues } from "./native-core";

export type EdpDocumentRole = "chinese_edp" | "english_edp" | "supplement" | "moc";
export type EdpSubmissionRound = 1 | 2 | 3 | 4 | 5;
export type EdpReasonCode = "file_count" | "file_format" | "classification";

export interface EdpPackageDocument {
  role: EdpDocumentRole;
  path: string;
  displayPath: string;
  bytes: Uint8Array;
  roleEvidence: "filename" | "first_page" | "unique_remaining_role";
}

export interface EdpRegistrationCandidate {
  path: string;
  displayPath: string;
  bytes: Uint8Array;
}

export interface EdpPackageInspection {
  qualified: boolean;
  archiveFormat: EdpArchiveFormat | null;
  coreFileCount: number;
  visibleFileCount: number;
  documents: EdpPackageDocument[];
  registrationCandidates: EdpRegistrationCandidate[];
  reasonCode?: EdpReasonCode;
  reasonCodes: EdpReasonCode[];
  reasons: string[];
}

export interface InspectEdpPackageOptions {
  openArchive?: (bytes: Uint8Array, filename: string) => Promise<OpenedEdpArchive>;
  extractFirstPageText?: (bytes: Uint8Array, path: string) => Promise<string>;
  validatePdfContents?: boolean;
}

async function defaultOpenArchive(bytes: Uint8Array, filename: string): Promise<OpenedEdpArchive> {
  if (sniffEdpArchiveFormat(bytes, filename) === "zip") {
    return openEdpArchiveCore(bytes, filename, {
      async readLibarchiveEntries() {
        throw new Error("ZIP 读取不应调用 libarchive。");
      },
    });
  }
  const testReader = (globalThis as typeof globalThis & {
    __CHEMECAR_TEST_READ_LIBARCHIVE__?: (value: Uint8Array) => Promise<import("./edp-archive-core").LibarchiveEntryPayload[]>;
  }).__CHEMECAR_TEST_READ_LIBARCHIVE__;
  if (testReader) return openEdpArchiveCore(bytes, filename, { readLibarchiveEntries: testReader });
  const { openEdpArchive } = await import("./edp-archive");
  return openEdpArchive(bytes, filename);
}

const SYSTEM_BASENAMES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

function basename(pathname: string): string {
  return pathname.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) || pathname;
}

function isIgnoredEntry(entry: EdpArchiveEntry): boolean {
  if (entry.isDirectory) return true;
  const parts = entry.normalizedPath.replaceAll("\\", "/").split("/").filter(Boolean);
  const leaf = parts.at(-1)?.toLocaleLowerCase("en-US") || "";
  return parts.some((part) => part.toLocaleLowerCase("en-US") === "__macosx")
    || leaf.startsWith("._")
    || SYSTEM_BASENAMES.has(leaf);
}

function hasPdfHeader(bytes: Uint8Array): boolean {
  return bytes.length >= 5
    && bytes[0] === 0x25
    && bytes[1] === 0x50
    && bytes[2] === 0x44
    && bytes[3] === 0x46
    && bytes[4] === 0x2d;
}

function roleFromFilename(pathname: string): EdpDocumentRole | null {
  const stem = basename(pathname).replace(/\.[^.]+$/u, "").normalize("NFKC");
  const lower = stem.toLocaleLowerCase("en-US");
  const hasHan = /\p{Script=Han}/u.test(stem);
  const latinWords = lower.match(/[a-z]{2,}/gu) || [];
  if (/(^|[^a-z])moc([^a-z]|$)|management\s+of\s+change|变更管理/iu.test(stem)) return "moc";
  if (/supplement|addendum|增补|补充|补遗/iu.test(stem)) return "supplement";
  if (/english|英文|英语/iu.test(stem)) return "english_edp";
  if (/chinese|中文版|中文/iu.test(stem)) return "chinese_edp";
  if (!hasHan && /edp/iu.test(stem) && latinWords.some((word) => !["edp", "pdf"].includes(word))) return "english_edp";
  if (hasHan && /edp/iu.test(stem)) return "chinese_edp";
  return null;
}

function isMocRequestFormCover(text: string): boolean {
  const cover = text.normalize("NFKC").replace(/\s+/gu, " ").trim().slice(0, 600);
  const title = /management\s+of\s+change\s+(?:request\s+)?form|变更管理(?:申请)?表/iu.exec(cover);
  if (!title) return false;
  // An EDP cover can mention the MOC requirement; only the actual form title
  // preceding an EDP title can override a misleading file name.
  return !/engineering\s+documentation\s+package|工程文件包/iu.test(cover.slice(0, title.index));
}

function roleFromFirstPage(text: string): EdpDocumentRole | null {
  const normalized = text.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized) return null;
  if (isMocRequestFormCover(normalized)) return "moc";
  if (/edp\s+(?:supplement|addendum)|supplement(?:al)?\s+(?:file|information)|增补文件|补充文件|补遗/iu.test(normalized)) return "supplement";
  if (/engineering\s+documentation\s+package|chem[-\s]?e[-\s]?car.*\bedp\b/iu.test(normalized)) return "english_edp";
  if (/工程文件包/u.test(normalized) && /工作安全评估表|动力来源|控制机制|标准安全操作/u.test(normalized)) return "chinese_edp";
  return null;
}

async function defaultExtractFirstPageText(bytes: Uint8Array): Promise<string> {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({ data: bytes, useSystemFonts: true });
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    const content = await page.getTextContent();
    page.cleanup();
    return content.items
      .map((item) => item && typeof item === "object" && "str" in item && typeof item.str === "string" ? item.str : "")
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/gu, " ")
      .trim();
  } finally {
    await task.destroy();
  }
}

function expectedRoles(round: EdpSubmissionRound): EdpDocumentRole[] {
  return round === 1
    ? ["chinese_edp", "english_edp", "supplement"]
    : ["chinese_edp", "english_edp", "supplement", "moc"];
}

function addProblem(
  reasonCodes: EdpReasonCode[],
  reasons: string[],
  code: EdpReasonCode,
  message: string,
): void {
  if (!reasonCodes.includes(code)) reasonCodes.push(code);
  if (!reasons.includes(message)) reasons.push(message);
}

export async function inspectEdpPackage(
  bytes: Uint8Array,
  filename: string,
  submissionRound: EdpSubmissionRound,
  options: InspectEdpPackageOptions = {},
): Promise<EdpPackageInspection> {
  const archive = await (options.openArchive || defaultOpenArchive)(bytes, filename);
  const extractFirstPageText = options.extractFirstPageText || defaultExtractFirstPageText;
  const expected = expectedRoles(submissionRound);
  const visible = archive.entries.filter((entry) => !isIgnoredEntry(entry));
  const registrationCandidates: EdpRegistrationCandidate[] = [];
  const pdfEntries: EdpArchiveEntry[] = [];
  const invalidEntries: string[] = [];

  for (const entry of visible) {
    const leaf = basename(entry.normalizedPath);
    if (/\.xlsx$/iu.test(leaf)) {
      if (entry.bytes) registrationCandidates.push({ path: entry.normalizedPath, displayPath: entry.displayPath, bytes: entry.bytes });
      continue;
    }
    if (!/\.pdf$/iu.test(leaf) || !entry.bytes || !hasPdfHeader(entry.bytes)) invalidEntries.push(entry.displayPath);
    else pdfEntries.push(entry);
  }

  const firstPageTextByPath = new Map<string, string>();
  const unreadablePdfPaths = new Set<string>();
  if (options.validatePdfContents) {
    for (const entry of pdfEntries) {
      try {
        firstPageTextByPath.set(
          entry.normalizedPath,
          await extractFirstPageText(entry.bytes as Uint8Array, entry.normalizedPath),
        );
      } catch (error) {
        unreadablePdfPaths.add(entry.normalizedPath);
        const detail = error instanceof Error ? error.message.replace(/\s+/gu, " ").trim().slice(0, 120) : "";
        invalidEntries.push(`${entry.displayPath}（PDF 无法解读${detail ? `：${detail}` : ""}）`);
      }
    }
  }

  const reasonCodes: EdpReasonCode[] = [];
  const reasons: string[] = [];
  const coreFileCount = visible.length - registrationCandidates.length;
  if (coreFileCount !== expectedPdfCount(submissionRound)) {
    addProblem(
      reasonCodes,
      reasons,
      "file_count",
      `第${submissionRound}次提交应包含 ${expected.length} 个核心 PDF 文件，当前识别到 ${coreFileCount} 个（报名表不计入）。`,
    );
  }
  if (invalidEntries.length > 0) {
    addProblem(reasonCodes, reasons, "file_format", `下列业务文件不是有效 PDF：${invalidEntries.join("；")}。`);
  }

  const classified: Array<EdpPackageDocument | null> = [];
  for (const entry of pdfEntries) {
    if (unreadablePdfPaths.has(entry.normalizedPath)) {
      classified.push(null);
      continue;
    }
    let role: EdpDocumentRole | null = null;
    let roleEvidence: EdpPackageDocument["roleEvidence"] = "filename";
    if (entry.displayNameStatus !== "uncertain") role = roleFromFilename(entry.displayPath);
    const validatedCover = firstPageTextByPath.get(entry.normalizedPath);
    if (validatedCover && isMocRequestFormCover(validatedCover)) {
      role = "moc";
      roleEvidence = "first_page";
    }
    if (!role) {
      let firstPage = firstPageTextByPath.get(entry.normalizedPath) ?? "";
      if (!firstPageTextByPath.has(entry.normalizedPath)) {
        try {
          firstPage = await extractFirstPageText(entry.bytes as Uint8Array, entry.normalizedPath);
        } catch {
          firstPage = "";
        }
      }
      role = roleFromFirstPage(firstPage);
      roleEvidence = "first_page";
    }
    classified.push(role ? {
      role,
      path: entry.normalizedPath,
      displayPath: entry.displayPath,
      bytes: entry.bytes as Uint8Array,
      roleEvidence,
    } : null);
  }

  const assignedRoles = classified.filter((document): document is EdpPackageDocument => Boolean(document)).map(({ role }) => role);
  const unclassifiedIndexes = classified.flatMap((document, index) => document || unreadablePdfPaths.has(pdfEntries[index].normalizedPath) ? [] : [index]);
  const missingRoles = expected.filter((role) => !assignedRoles.includes(role));
  if (unclassifiedIndexes.length === 1 && missingRoles.length === 1) {
    const index = unclassifiedIndexes[0];
    const entry = pdfEntries[index];
    classified[index] = {
      role: missingRoles[0],
      path: entry.normalizedPath,
      displayPath: entry.displayPath,
      bytes: entry.bytes as Uint8Array,
      roleEvidence: "unique_remaining_role",
    };
  }

  const documents = classified.filter((document): document is EdpPackageDocument => Boolean(document));
  const ambiguous = pdfEntries
    .filter((entry, index) => !unreadablePdfPaths.has(entry.normalizedPath) && !classified[index])
    .map(({ displayPath }) => displayPath);
  if (ambiguous.length > 0) {
    addProblem(reasonCodes, reasons, "classification", `无法唯一判断下列 PDF 的用途：${ambiguous.join("；")}。`);
  }
  for (const role of expected) {
    const matches = documents.filter((document) => document.role === role);
    if (matches.length === 0) {
      addProblem(
        reasonCodes,
        reasons,
        "classification",
        role === "moc"
          ? `第${submissionRound}次提交必须包含 1 份 MOC，当前识别到 0 份。`
          : `缺少 ${role === "chinese_edp" ? "中文版 EDP" : role === "english_edp" ? "英文版 EDP" : "EDP 增补文件"}。`,
      );
    } else if (matches.length > 1) {
      addProblem(reasonCodes, reasons, "classification", `有 ${matches.length} 个文件同时被识别为 ${role}：${matches.map(({ displayPath }) => displayPath).join("；")}。`);
    }
  }
  const unexpectedRoles = documents.filter(({ role }) => !expected.includes(role));
  if (unexpectedRoles.length > 0) {
    addProblem(
      reasonCodes,
      reasons,
      "classification",
      submissionRound === 1 && unexpectedRoles.some(({ role }) => role === "moc")
        ? `第1次提交不应包含 MOC：${unexpectedRoles.map(({ displayPath }) => displayPath).join("；")}。`
        : `本次提交不应包含：${unexpectedRoles.map(({ displayPath }) => displayPath).join("；")}。`,
    );
  }

  return {
    qualified: reasonCodes.length === 0 && packageIssues(submissionRound, coreFileCount,
      ...(["chinese_edp", "english_edp", "supplement", "moc"] as const)
        .map(role => documents.filter(document => document.role === role).length) as [number,number,number,number],
      invalidEntries.length) === 0,
    archiveFormat: archive.format,
    coreFileCount,
    visibleFileCount: visible.length,
    documents,
    registrationCandidates,
    reasonCode: reasonCodes[0],
    reasonCodes,
    reasons,
  };
}
