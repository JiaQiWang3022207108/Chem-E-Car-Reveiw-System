export const CERTIFICATE_WIDTH_PX = 3508;
export const CERTIFICATE_HEIGHT_PX = 2480;
export const CERTIFICATE_PREVIEW_WIDTH_PX = 1754;
export const CERTIFICATE_PREVIEW_HEIGHT_PX = 1240;

const FRAME_COLOR = "#9b6a28";
const TEXT_COLOR = "#2c2117";
const ACCENT_COLOR = "#b18440";
const PAGE_MARGIN = 120;
const TITLE_FONT_PX = 168;
const BODY_FONT_PX = 70;
const BODY_MIN_FONT_PX = 44;
const NAME_FONT_PX = 58;
const NAME_MIN_FONT_PX = 34;
const ISSUER_FONT_PX = 54;
const ISSUER_MIN_FONT_PX = 36;
const LINE_HEIGHT = 1.34;
const MAX_INSTRUCTORS = 5;
const MAX_MEMBERS = 15;

export const APPROVED_CJK_FONT_FAMILIES = ["Microsoft YaHei", "Microsoft YaHei UI", "SimSun"] as const;

export interface CertificateDraft {
  competitionYear: string;
  eventName: string;
  issuerText: string;
  schoolName: string;
  awardName: string;
  instructorsText: string;
  membersText: string;
  issueMonth: string;
}

export interface CertificateData extends Omit<CertificateDraft, "instructorsText" | "membersText"> {
  instructors: string[];
  members: string[];
}

export type CertificateField = "competitionYear" | "eventName" | "issuerText" | "schoolName" | "awardName" | "instructors" | "members" | "issueMonth";

export type CertificatePreparation =
  | { ok: true; data: CertificateData; warnings: string[] }
  | { ok: false; errors: Array<{ field: CertificateField; message: string }>; warnings: string[] };

export interface CertificateTextRun {
  field: CertificateField;
  text: string;
  x: number;
  y: number;
  fontPx: number;
  color: string;
  align: CanvasTextAlign;
  weight: 500 | 600 | 700;
}

export interface CertificateLayout {
  runs: CertificateTextRun[];
  issuerLines: CertificateTextRun[];
  stampBox: { x: number; y: number; width: number; height: number };
  overflowField: CertificateField | null;
}

type Measure = (text: string, fontPx: number, weight: number) => number;
type FittedLines = { lines: string[]; fontPx: number; lineHeight: number } | null;

const loadedFonts = new WeakMap<object, FontFace>();

export async function resolveCertificateFontFamily(fonts?: Pick<FontFaceSet, "add"> | null, Face?: typeof FontFace): Promise<string> {
  const availableFonts = fonts ?? (typeof document === "undefined" ? null : document.fonts);
  const FontFaceClass = Face ?? (typeof FontFace === "undefined" ? null : FontFace);
  const existing = availableFonts && loadedFonts.get(availableFonts);
  if (existing?.status === "loaded") return existing.family;
  if (availableFonts && FontFaceClass) {
    for (const [index, family] of APPROVED_CJK_FONT_FAMILIES.entries()) {
      try {
        // A local source rejects if not installed; FontFaceSet.check may return true for fallback.
        const face = new FontFaceClass(`CertificateCJK${index}`, `local("${family}")`);
        await face.load();
        if (face.status !== "loaded") continue;
        availableFonts.add(face);
        loadedFonts.set(availableFonts, face);
        return face.family;
      } catch { /* Try the next explicitly approved local face. */ }
    }
  }
  throw new Error("未检测到可用的中文证书字体。请安装 Microsoft YaHei 或 SimSun 后重试。");
}

function readyCertificateFontFamily(): string {
  const face = typeof document === "undefined" ? undefined : loadedFonts.get(document.fonts);
  if (face?.status === "loaded") return face.family;
  throw new Error("未检测到可用的中文证书字体。请安装 Microsoft YaHei 或 SimSun 后重试。");
}

function canvasFont(weight: number, fontPx: number, family: string) {
  return `${weight} ${fontPx}px "${family}"`;
}

function normalized(value: string) {
  return value.trim().replace(/\s+/gu, " ");
}

export function parseCertificateNames(value: string): string[] {
  return value.split(/[\s、，,；;]+/u).map((name) => name.trim()).filter(Boolean);
}

function duplicateWarnings(label: string, names: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = [...new Set(names.filter((name) => {
    if (seen.has(name)) return true;
    seen.add(name);
    return false;
  }))];
  return duplicates.length ? [`${label}中有重复姓名：${duplicates.join("、")}`] : [];
}

export function prepareCertificateData(draft: CertificateDraft): CertificatePreparation {
  const instructors = parseCertificateNames(draft.instructorsText);
  const members = parseCertificateNames(draft.membersText);
  const data: CertificateData = {
    competitionYear: normalized(draft.competitionYear),
    eventName: normalized(draft.eventName),
    issuerText: draft.issuerText.trim(),
    schoolName: normalized(draft.schoolName),
    awardName: normalized(draft.awardName),
    issueMonth: normalized(draft.issueMonth),
    instructors,
    members,
  };
  const warnings = [...duplicateWarnings("指导教师", instructors), ...duplicateWarnings("队员", members)];
  const errors: Array<{ field: CertificateField; message: string }> = [];
  const required: Array<[CertificateField, string]> = [
    ["competitionYear", data.competitionYear], ["eventName", data.eventName], ["issuerText", data.issuerText],
    ["schoolName", data.schoolName], ["awardName", data.awardName], ["issueMonth", data.issueMonth],
  ];
  for (const [field, value] of required) {
    if (!value) errors.push({ field, message: field === "competitionYear" ? "请先到 EDP 审核设置选择竞赛年份。" : "此项不能为空。" });
  }
  if (!instructors.length) errors.push({ field: "instructors", message: "请至少填写一名指导教师。" });
  if (!members.length) errors.push({ field: "members", message: "请至少填写一名队员。" });
  if (data.competitionYear && !/^20\d{2}$/u.test(data.competitionYear)) errors.push({ field: "competitionYear", message: "请到 EDP 审核设置选择有效的四位竞赛年份。" });
  if (data.issueMonth && !/^20\d{2}-(0[1-9]|1[0-2])$/u.test(data.issueMonth)) errors.push({ field: "issueMonth", message: "月份必须为 YYYY-MM 格式。" });
  if (instructors.length > MAX_INSTRUCTORS) errors.push({ field: "instructors", message: `指导教师不能超过${MAX_INSTRUCTORS}人。` });
  if (members.length > MAX_MEMBERS) errors.push({ field: "members", message: `队员不能超过${MAX_MEMBERS}人。` });
  return errors.length ? { ok: false, errors, warnings } : { ok: true, data, warnings };
}

function wrapText(text: string, maxWidth: number, measure: Measure, fontPx: number, weight: number): string[] {
  const units = Array.from(text);
  const lines: string[] = [];
  let current = "";
  for (const unit of units) {
    const candidate = current + unit;
    if (current && measure(candidate, fontPx, weight) > maxWidth) {
      lines.push(current.trimEnd());
      current = unit.trimStart();
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current.trimEnd());
  return lines.length ? lines : [""];
}

function fitText(
  text: string,
  maxWidth: number,
  maxLines: number,
  startPx: number,
  minPx: number,
  weight: number,
  measure: Measure,
  compactLineSpacing = false,
  maxHeight = Number.POSITIVE_INFINITY,
): FittedLines {
  for (let fontPx = startPx; fontPx >= minPx; fontPx -= 2) {
    if (Array.from(text).some((unit) => !/^\s$/u.test(unit) && measure(unit, fontPx, weight) > maxWidth)) continue;
    const lines = wrapText(text, maxWidth, measure, fontPx, weight);
    if (lines.length > maxLines) continue;
    for (const lineHeight of compactLineSpacing ? [LINE_HEIGHT, 1.16] : [LINE_HEIGHT]) {
      if (lines.length * fontPx * lineHeight <= maxHeight) return { lines, fontPx, lineHeight };
    }
  }
  return null;
}

function makeRuns(field: CertificateField, lines: string[], fontPx: number, centerX: number, firstY: number, color: string, weight: 500 | 600 | 700, lineHeight = LINE_HEIGHT): CertificateTextRun[] {
  const lineStep = fontPx * lineHeight;
  return lines.map((text, index) => ({ field, text, x: centerX, y: firstY + index * lineStep, fontPx, color, align: "center", weight }));
}

export function createCertificateLayout(data: CertificateData, measure: Measure, width: number, height: number): CertificateLayout {
  // Fitting always uses canonical 300-DPI coordinates, including the 2px size step.
  // Only the finished layout is scaled, so preview and export cannot wrap differently.
  const scale = Math.min(width / CERTIFICATE_WIDTH_PX, height / CERTIFICATE_HEIGHT_PX);
  const layout = canonicalCertificateLayout(data, measure);
  const scaleRun = (run: CertificateTextRun) => ({ ...run, x: run.x * scale, y: run.y * scale, fontPx: run.fontPx * scale });
  return { ...layout, runs: layout.runs.map(scaleRun), issuerLines: layout.issuerLines.map(scaleRun), stampBox: {
    x: layout.stampBox.x * scale, y: layout.stampBox.y * scale, width: layout.stampBox.width * scale, height: layout.stampBox.height * scale,
  } };
}

function canonicalCertificateLayout(data: CertificateData, measure: Measure): CertificateLayout {
  const width = CERTIFICATE_WIDTH_PX;
  const height = CERTIFICATE_HEIGHT_PX;
  const centerX = width / 2;
  const runs: CertificateTextRun[] = [];
  const stampBox = { x: width - 690, y: height - 650, width: 310, height: 310 };
  let cursorY = 560;
  const add = (field: CertificateField, text: string, startPx: number, minPx: number, maxLines: number, weight: 500 | 600 | 700 = 500, gap = 40, compactList = false, color = TEXT_COLOR) => {
    const availableHeight = compactList ? height - 710 - cursorY : Number.POSITIVE_INFINITY;
    const fitted = fitText(text, width - PAGE_MARGIN * 2, maxLines, startPx, minPx, weight, measure, compactList, availableHeight);
    if (!fitted) return field;
    runs.push(...makeRuns(field, fitted.lines, fitted.fontPx, centerX, cursorY, color, weight, fitted.lineHeight));
    cursorY += fitted.lines.length * fitted.fontPx * fitted.lineHeight + gap;
    return null;
  };

  runs.push({ field: "eventName", text: "获奖证书", x: centerX, y: 315, fontPx: TITLE_FONT_PX, color: FRAME_COLOR, align: "center", weight: 700 });
  let overflowField = add("schoolName", `${data.schoolName} 参赛队：`, 82, 50, 2, 600)
    ?? add("eventName", `在${data.competitionYear} ${data.eventName}中，表现卓越，并获得`, BODY_FONT_PX, BODY_MIN_FONT_PX, 2)
    ?? add("awardName", data.awardName, 82, 50, 2, 600, 42, false, FRAME_COLOR)
    ?? add("awardName", "特发此证，以资鼓励！", BODY_FONT_PX, BODY_MIN_FONT_PX, 1)
    ?? add("instructors", `指导教师：${data.instructors.join("、")}`, NAME_FONT_PX, NAME_MIN_FONT_PX, 2, 500, 26, true)
    ?? add("members", `参赛队员：${data.members.join("、")}`, NAME_FONT_PX, NAME_MIN_FONT_PX, 3, 500, 0, true);

  if (!overflowField && cursorY > height - 710) overflowField = "members";
  const issuerLines: CertificateTextRun[] = [];
  if (!overflowField) {
    for (let fontPx = ISSUER_FONT_PX; fontPx >= ISSUER_MIN_FONT_PX; fontPx -= 2) {
      const lines = data.issuerText.split(/\r?\n/gu).flatMap((line) => wrapText(line, 760, measure, fontPx, 500));
      if (lines.length > 3 || lines.some((line) => measure(line, fontPx, 500) > 760)) continue;
      issuerLines.push(...lines.map((text, index): CertificateTextRun => ({
        field: "issuerText", text, x: width - 300, y: height - 440 + index * fontPx * LINE_HEIGHT,
        fontPx, color: TEXT_COLOR, align: "right", weight: 500,
      })));
      break;
    }
    if (!issuerLines.length) overflowField = "issuerText";
    const [year, month] = data.issueMonth.split("-");
    issuerLines.push({ field: "issueMonth", text: `${year}年${Number(month)}月`, x: width - 300, y: height - 220, fontPx: ISSUER_FONT_PX, color: TEXT_COLOR, align: "right", weight: 500 });
  }
  for (const run of [...runs, ...issuerLines]) {
    const textWidth = measure(run.text, run.fontPx, run.weight);
    const footer = issuerLines.includes(run);
    const left = run.x - (run.align === "right" ? textWidth : textWidth / 2);
    const right = run.x + (run.align === "right" ? 0 : textWidth / 2);
    if (left < (footer ? width - 1060 : PAGE_MARGIN) || right > (footer ? width - 300 : width - PAGE_MARGIN)
      || run.y - run.fontPx < (footer ? height - 540 : PAGE_MARGIN)
      || run.y + run.fontPx * 0.25 > (footer ? height - 180 : height - PAGE_MARGIN)) {
      overflowField ??= run.field;
    }
  }
  return { runs, issuerLines, stampBox, overflowField };
}

function drawFrame(context: CanvasRenderingContext2D, width: number, height: number) {
  const scale = Math.min(width / CERTIFICATE_WIDTH_PX, height / CERTIFICATE_HEIGHT_PX);
  const px = (value: number) => value * scale;
  context.fillStyle = "#fffdf8";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = FRAME_COLOR;
  context.lineWidth = px(12);
  context.strokeRect(px(72), px(72), width - px(144), height - px(144));
  context.lineWidth = px(3);
  context.strokeRect(px(100), px(100), width - px(200), height - px(200));
  context.strokeStyle = ACCENT_COLOR;
  context.lineWidth = px(5);
  for (let x = px(180); x < width - px(180); x += px(95)) {
    context.save();
    context.translate(x, px(135));
    context.rotate(Math.PI / 4);
    context.strokeRect(-px(10), -px(10), px(20), px(20));
    context.restore();
    context.save();
    context.translate(x, height - px(135));
    context.rotate(Math.PI / 4);
    context.strokeRect(-px(10), -px(10), px(20), px(20));
    context.restore();
  }
  for (const [x, y] of [[px(145), px(145)], [width - px(145), px(145)], [px(145), height - px(145)], [width - px(145), height - px(145)]]) {
    context.save();
    context.translate(x, y);
    context.rotate(Math.PI / 4);
    context.strokeRect(-px(32), -px(32), px(64), px(64));
    context.strokeRect(-px(15), -px(15), px(30), px(30));
    context.restore();
  }
}

function sourceAspect(source: CanvasImageSource): number {
  const image = source as { naturalWidth?: number; naturalHeight?: number; videoWidth?: number; videoHeight?: number; width?: number; height?: number };
  const width = image.naturalWidth || image.videoWidth || image.width || 1;
  const height = image.naturalHeight || image.videoHeight || image.height || 1;
  return width / height;
}

export function renderCertificateCanvas(canvas: HTMLCanvasElement, data: CertificateData, stamp: CanvasImageSource, width = CERTIFICATE_WIDTH_PX, height = CERTIFICATE_HEIGHT_PX): CertificateLayout {
  const fontFamily = readyCertificateFontFamily();
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器不支持二维画布。" );
  drawFrame(context, width, height);
  const layout = createCertificateLayout(data, (text, fontPx, weight) => {
    context.font = canvasFont(weight, fontPx, fontFamily);
    return context.measureText(text).width;
  }, width, height);
  if (layout.overflowField) return layout;
  const scale = Math.min(width / CERTIFICATE_WIDTH_PX, height / CERTIFICATE_HEIGHT_PX);
  // Validate actual ink extents (including glyph overhang), not only advance widths.
  // Do this for every run before drawing any text or seal.
  for (const run of [...layout.runs, ...layout.issuerLines]) {
    context.font = canvasFont(run.weight, run.fontPx, fontFamily);
    context.textAlign = run.align;
    context.textBaseline = "alphabetic";
    const metrics = context.measureText(run.text);
    const footer = layout.issuerLines.includes(run);
    const left = run.x - (metrics.actualBoundingBoxLeft ?? (run.align === "right" ? metrics.width : metrics.width / 2));
    const right = run.x + (metrics.actualBoundingBoxRight ?? (run.align === "right" ? 0 : metrics.width / 2));
    const top = run.y - (metrics.actualBoundingBoxAscent ?? run.fontPx);
    const bottom = run.y + (metrics.actualBoundingBoxDescent ?? run.fontPx * 0.25);
    if (left < (footer ? CERTIFICATE_WIDTH_PX - 1060 : PAGE_MARGIN) * scale
      || right > (footer ? CERTIFICATE_WIDTH_PX - 300 : CERTIFICATE_WIDTH_PX - PAGE_MARGIN) * scale
      || top < (footer ? CERTIFICATE_HEIGHT_PX - 540 : PAGE_MARGIN) * scale
      || bottom > (footer ? CERTIFICATE_HEIGHT_PX - 180 : CERTIFICATE_HEIGHT_PX - PAGE_MARGIN) * scale) {
      return { ...layout, overflowField: run.field };
    }
  }
  for (const run of [...layout.runs, ...layout.issuerLines]) {
    context.font = canvasFont(run.weight, run.fontPx, fontFamily);
    context.fillStyle = run.color;
    context.textAlign = run.align;
    context.textBaseline = "alphabetic";
    context.fillText(run.text, run.x, run.y);
  }
  const aspect = sourceAspect(stamp);
  const stampWidth = Math.min(layout.stampBox.width, layout.stampBox.height * aspect);
  const stampHeight = stampWidth / aspect;
  context.drawImage(stamp, layout.stampBox.x + (layout.stampBox.width - stampWidth) / 2, layout.stampBox.y + (layout.stampBox.height - stampHeight) / 2, stampWidth, stampHeight);
  return layout;
}

export function certificateFilename(data: CertificateData): string {
  const safePart = (value: unknown) => String(value ?? "")
    // eslint-disable-next-line no-control-regex -- Windows reserves ASCII control characters in filenames.
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/gu, "-")
    .replace(/[\s-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  const parts = [safePart(data.schoolName), safePart(data.awardName)].filter(Boolean);
  return parts.length ? `${parts.join("-")}-获奖证书.pdf` : "团队获奖证书.pdf";
}

function csvCell(value: string): string {
  return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** One validated certificate row for Canva's Bulk Create CSV import. */
export function canvaCertificateCsv(data: CertificateData): string {
  const headers = [
    "竞赛年份", "赛事名称", "学校参赛队", "奖项名称",
    "指导教师", "参赛队员", "颁发月份", "落款文字",
  ];
  const row = [
    data.competitionYear,
    data.eventName,
    data.schoolName,
    data.awardName,
    data.instructors.join("、"),
    data.members.join("、"),
    data.issueMonth,
    data.issuerText,
  ];
  return `\uFEFF${headers.join(",")}\r\n${row.map(csvCell).join(",")}\r\n`;
}

function ascii(value: string) {
  return new TextEncoder().encode(value);
}

function joinBytes(parts: Uint8Array[]) {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

export function buildSinglePageJpegPdf(jpeg: Uint8Array, pixelWidth: number, pixelHeight: number): Uint8Array {
  const content = ascii("q\n841.89 0 0 595.28 0 0 cm\n/Im0 Do\nQ\n");
  const header = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52, 10, 37, 226, 227, 207, 211, 10]);
  const objects = [
    ascii("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    ascii("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    ascii("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 841.89 595.28] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n"),
    joinBytes([ascii(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pixelWidth} /Height ${pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.byteLength} >>\nstream\n`), jpeg, ascii("\nendstream\nendobj\n")]),
    joinBytes([ascii(`5 0 obj\n<< /Length ${content.byteLength} >>\nstream\n`), content, ascii("endstream\nendobj\n")]),
  ];
  const offsets: number[] = [];
  let offset = header.byteLength;
  for (const object of objects) {
    offsets.push(offset);
    offset += object.byteLength;
  }
  const xrefOffset = offset;
  const xref = ascii(`xref\n0 6\n0000000000 65535 f \n${offsets.map((value) => `${String(value).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return joinBytes([header, ...objects, xref]);
}

export async function canvasToCertificatePdf(canvas: HTMLCanvasElement): Promise<Blob> {
  readyCertificateFontFamily();
  const jpegBlob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("浏览器无法编码证书图像。")), "image/jpeg", 0.98);
  });
  const pdf = buildSinglePageJpegPdf(new Uint8Array(await jpegBlob.arrayBuffer()), canvas.width, canvas.height);
  const blobBytes = new Uint8Array(pdf.byteLength);
  blobBytes.set(pdf);
  return new Blob([blobBytes.buffer], { type: "application/pdf" });
}
