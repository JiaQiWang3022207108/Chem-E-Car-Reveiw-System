import JSZip from "jszip";
import * as XLSX from "xlsx";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

export const categories = ["报价", "订单", "合同", "发票", "客户资料", "邮件", "其他"] as const;
export type Category = (typeof categories)[number];
export type NamingPattern = "date-contact-category" | "date-category-subject" | "category-contact-date" | "keep";

export interface OrganizedFile {
  id: string;
  file: File;
  originalName: string;
  sourcePath: string;
  extension: string;
  category: Category;
  date: string;
  contact: string;
  subject: string;
  emails: string[];
  phones: string[];
  excerpt: string;
  confidence: number;
  newName: string;
  warning?: string;
}

interface CollectedFile { file: File; sourcePath: string }

const accepted = new Set(["xlsx", "xls", "csv", "pdf", "zip"]);
const keywordGroups: Array<{ category: Category; words: string[] }> = [
  { category: "报价", words: ["报价", "询价", "价格表", "quotation", "quote", "price list"] },
  { category: "订单", words: ["订单", "采购单", "订购", "order", "purchase order", "po number"] },
  { category: "合同", words: ["合同", "协议", "签约", "contract", "agreement"] },
  { category: "发票", words: ["发票", "开票", "税号", "invoice", "vat"] },
  { category: "邮件", words: ["发件人", "收件人", "抄送", "邮件主题", "from:", "to:", "subject:"] },
  { category: "客户资料", words: ["客户资料", "联系人", "联系电话", "公司名称", "customer", "client", "contact"] },
];

function extOf(name: string) {
  const match = name.toLowerCase().match(/\.([^.]+)$/);
  return match?.[1] ?? "";
}

function mimeFor(ext: string) {
  return ({
    pdf: "application/pdf",
    csv: "text/csv",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xls: "application/vnd.ms-excel",
    zip: "application/zip",
  } as Record<string, string>)[ext] ?? "application/octet-stream";
}

function cleanText(value: string) {
  return value.split("\u0000").join(" ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export function sanitizeName(value: string) {
  const withoutControlCharacters = Array.from(value, (character) => character.charCodeAt(0) <= 0x1f ? "-" : character).join("");
  return withoutControlCharacters
    .replace(/[<>:"/\\|?*]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 110) || "未命名文件";
}

function normalizeDate(raw: string) {
  const numbers = raw.match(/\d+/g);
  if (!numbers || numbers.length < 3) return "";
  const [rawYear, month, day] = numbers;
  const year = rawYear.length === 2 ? `20${rawYear}` : rawYear;
  const y = Number(year), m = Number(month), d = Number(day);
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return "";
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function extractDate(text: string, file: File) {
  const patterns = [
    /(?:20)?\d{2}[年/.-]\d{1,2}[月/.-]\d{1,2}日?/g,
    /\d{1,2}[/.-]\d{1,2}[/.-]20\d{2}/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.match(pattern) ?? []) {
      const normalized = normalizeDate(match);
      if (normalized) return normalized;
    }
  }
  return new Date(file.lastModified || Date.now()).toISOString().slice(0, 10);
}

function extractEmails(text: string) {
  return [...new Set((text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []).map((item) => item.toLowerCase()))].slice(0, 8);
}

function extractPhones(text: string) {
  const matches = text.match(/(?<!\d)(?:\+?86[- ]?)?(?:1[3-9]\d{9}|0\d{2,3}[- ]?\d{7,8})(?!\d)/g) ?? [];
  return [...new Set(matches.map((item) => item.replace(/\s+/g, "")))].slice(0, 8);
}

function detectCategory(text: string, fileName: string): { category: Category; score: number } {
  const haystack = `${fileName}\n${text.slice(0, 18000)}`.toLowerCase();
  let best: { category: Category; score: number } = { category: "其他", score: 0 };
  for (const group of keywordGroups) {
    const score = group.words.reduce((total, word) => total + (haystack.includes(word.toLowerCase()) ? 1 : 0), 0);
    if (score > best.score) best = { category: group.category, score };
  }
  if (best.score === 0 && /\.xlsx?$|\.csv$/i.test(fileName)) return { category: "客户资料", score: 1 };
  return best;
}

function extractContact(text: string, emails: string[]) {
  const label = text.match(/(?:客户名称|公司名称|客户|联系人|姓名|发件人|from)\s*[:：]\s*([^\n,，;；]{2,40})/i)?.[1];
  if (label) return sanitizeName(label.replace(/<.*?>/g, "").trim());
  const company = text.match(/[^\n,，;；]{2,35}(?:有限责任公司|股份有限公司|有限公司|集团|工作室|商行|中心)/)?.[0];
  if (company) return sanitizeName(company.trim());
  if (emails[0]) return sanitizeName(emails[0].split("@")[0].replace(/[._-]+/g, " "));
  return "未识别客户";
}

function extractSubject(text: string, originalName: string) {
  const labelled = text.match(/(?:邮件主题|主题|subject|标题)\s*[:：]\s*([^\n]{2,80})/i)?.[1];
  if (labelled) return sanitizeName(labelled.trim()).slice(0, 45);
  const ignored = /^(发件人|收件人|电话|邮箱|日期|序号|姓名|客户|from|to|date|email)\s*[:：]?$/i;
  const line = text.split(/\r?\n/).map((item) => item.trim()).find((item) => item.length >= 4 && item.length <= 70 && !ignored.test(item) && !item.includes("@"));
  if (line) return sanitizeName(line).slice(0, 45);
  return sanitizeName(originalName.replace(/\.[^.]+$/, "")).slice(0, 45);
}

async function readPdf(file: File) {
  const pdfjs = await import("pdfjs-dist/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const document = await pdfjs.getDocument({ data: bytes }).promise;
  const chunks: string[] = [];
  const pageLimit = Math.min(document.numPages, 40);
  for (let index = 1; index <= pageLimit; index += 1) {
    const page = await document.getPage(index);
    const content = await page.getTextContent();
    chunks.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
  }
  if (document.numPages > pageLimit) chunks.push(`[仅分析前 ${pageLimit} 页，共 ${document.numPages} 页]`);
  return chunks.join("\n");
}

async function readSpreadsheet(file: File, extension: string) {
  if (extension === "csv") return file.text();
  const book = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
  return book.SheetNames.slice(0, 12).map((name) => {
    const csv = XLSX.utils.sheet_to_csv(book.Sheets[name], { blankrows: false });
    return `工作表：${name}\n${csv}`;
  }).join("\n\n");
}

async function readContent(file: File, extension: string) {
  if (extension === "pdf") return readPdf(file);
  if (["xlsx", "xls", "csv"].includes(extension)) return readSpreadsheet(file, extension);
  return "";
}

async function collectOne(file: File, sourcePath: string, depth: number): Promise<CollectedFile[]> {
  const extension = extOf(file.name);
  if (extension !== "zip") return accepted.has(extension) ? [{ file, sourcePath }] : [];
  if (depth >= 3) return [{ file, sourcePath }];
  const archive = await JSZip.loadAsync(await file.arrayBuffer());
  const collected: CollectedFile[] = [];
  for (const entry of Object.values(archive.files)) {
    if (entry.dir || entry.name.startsWith("__MACOSX/") || /\/(?:\.DS_Store)$/i.test(entry.name)) continue;
    const entryName = entry.name.split("/").pop() || "未命名";
    const extension = extOf(entryName);
    if (!accepted.has(extension)) continue;
    const data = await entry.async("uint8array");
    const nested = new File([new Uint8Array(data)], entryName, { type: mimeFor(extension), lastModified: file.lastModified });
    collected.push(...await collectOne(nested, `${sourcePath}/${entry.name}`, depth + 1));
  }
  return collected;
}

export function suggestName(record: Pick<OrganizedFile, "originalName" | "extension" | "date" | "contact" | "category" | "subject">, pattern: NamingPattern) {
  if (pattern === "keep") return sanitizeName(record.originalName);
  const fields = pattern === "date-contact-category"
    ? [record.date, record.contact, record.category]
    : pattern === "date-category-subject"
      ? [record.date, record.category, record.subject]
      : [record.category, record.contact, record.date];
  return `${sanitizeName(fields.filter(Boolean).join("_"))}.${record.extension}`;
}

export async function processFiles(files: File[], onProgress?: (done: number, total: number, label: string) => void) {
  const collected: CollectedFile[] = [];
  for (const file of files) {
    try {
      collected.push(...await collectOne(file, file.name, 0));
    } catch {
      collected.push({ file, sourcePath: file.name });
    }
  }
  const output: OrganizedFile[] = [];
  for (let index = 0; index < collected.length; index += 1) {
    const { file, sourcePath } = collected[index];
    onProgress?.(index, collected.length, file.name);
    const extension = extOf(file.name);
    let text = "";
    let warning = "";
    try {
      text = cleanText(await readContent(file, extension));
      if (!text) warning = "未读取到可识别文字";
    } catch (error) {
      warning = error instanceof Error ? `解析失败：${error.message.slice(0, 90)}` : "解析失败";
    }
    const emails = extractEmails(text);
    const phones = extractPhones(text);
    const detected = detectCategory(text, file.name);
    const base = {
      originalName: file.name,
      extension,
      date: extractDate(text, file),
      contact: extractContact(text, emails),
      category: detected.category,
      subject: extractSubject(text, file.name),
    };
    const confidence = Math.min(98, 38 + detected.score * 14 + (emails.length ? 12 : 0) + (base.contact !== "未识别客户" ? 12 : 0) + (text.length > 80 ? 10 : 0));
    output.push({
      id: crypto.randomUUID(), file, sourcePath, ...base, emails, phones,
      excerpt: text.slice(0, 180).replace(/\n/g, " · "), confidence,
      newName: suggestName(base, "date-contact-category"), warning: warning || undefined,
    });
  }
  onProgress?.(collected.length, collected.length, "完成");
  return output;
}

function uniqueName(name: string, used: Set<string>) {
  let candidate = name;
  let count = 2;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  while (used.has(candidate.toLowerCase())) candidate = `${stem}_${count++}${extension}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

export async function downloadBundle(records: OrganizedFile[], groupByCategory: boolean) {
  const archive = new JSZip();
  const used = new Set<string>();
  const rows = [["原文件名", "新文件名", "分类", "日期", "客户/联系人", "邮箱", "电话", "来源路径"]];
  for (const record of records) {
    const safeFileName = uniqueName(sanitizeName(record.newName), used);
    const target = groupByCategory ? `${sanitizeName(record.category)}/${safeFileName}` : safeFileName;
    archive.file(target, await record.file.arrayBuffer());
    rows.push([record.originalName, safeFileName, record.category, record.date, record.contact, record.emails.join("; "), record.phones.join("; "), record.sourcePath]);
  }
  const escapeCsv = (value: string) => `"${String(value).replace(/"/g, '""')}"`;
  archive.file("整理清单.csv", `\ufeff${rows.map((row) => row.map(escapeCsv).join(",")).join("\r\n")}`);
  const blob = await archive.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `整理结果_${new Date().toISOString().slice(0, 10)}.zip`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
