import { manualFileMetadata, normalizeCompetitionSchoolName } from "./file-metadata";

/** Shared poster/video persistence helpers for the Cloudflare Worker. */

export type MediaAssetKind = "poster" | "video";
export type MediaAssetSource = "web" | "email";

export interface MediaD1PreparedStatement {
  bind(...values: unknown[]): MediaD1PreparedStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface MediaD1Database {
  prepare(query: string): MediaD1PreparedStatement;
  batch(statements: MediaD1PreparedStatement[]): Promise<unknown[]>;
}

interface MediaR2Object extends R2HeadLike {
  writeHttpMetadata(headers: Headers): void;
}

interface MediaR2ObjectBody extends MediaR2Object {
  body: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface MediaR2UploadedPart {
  partNumber: number;
  etag: string;
}

interface MediaR2MultipartUpload {
  key: string;
  uploadId: string;
  uploadPart(
    partNumber: number,
    value: ReadableStream<Uint8Array> | Uint8Array | ArrayBuffer,
  ): Promise<MediaR2UploadedPart>;
  complete(parts: MediaR2UploadedPart[]): Promise<MediaR2Object>;
  abort(): Promise<void>;
}

interface MediaR2Conditional {
  etagMatches?: string;
  etagDoesNotMatch?: string;
}

export interface MediaR2Bucket {
  head(key: string): Promise<MediaR2Object | null>;
  get(key: string): Promise<MediaR2ObjectBody | null>;
  put(
    key: string,
    value: ReadableStream<Uint8Array> | Uint8Array | ArrayBuffer,
    options: {
      onlyIf: MediaR2Conditional;
      httpMetadata: { contentType: string };
      customMetadata: Record<string, string>;
    },
  ): Promise<MediaR2Object | null>;
  createMultipartUpload(
    key: string,
    options: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<MediaR2MultipartUpload>;
  resumeMultipartUpload(key: string, uploadId: string): MediaR2MultipartUpload;
  delete(key: string): Promise<void>;
}

export interface MediaAssetsEnv {
  DB: MediaD1Database;
  FILES: MediaR2Bucket;
}

export interface MediaAsset {
  kind: MediaAssetKind;
  schoolKey: string;
  schoolName: string;
  filename: string;
  contentType: string;
  size: number;
  submittedAt: string;
  submissionId: string;
  uploadedAt: string;
  source: MediaAssetSource;
  sourceRef: string | null;
  downloadUrl: string;
}

export interface StoredMediaAssetImportInput {
  kind: MediaAssetKind;
  schoolName: string;
  filename: string;
  submittedAt: string;
  submissionId: string;
  source: MediaAssetSource;
  sourceRef?: string | null;
}

export interface MediaAssetImportResult {
  accepted: boolean;
  reason?: "duplicate" | "older-or-equal" | "superseded";
  asset: MediaAsset;
}

interface MediaAssetRow {
  kind: MediaAssetKind;
  school_key: string;
  school_name: string;
  r2_key: string;
  filename: string;
  content_type: string;
  size: number;
  submitted_at: string;
  submission_id: string;
  uploaded_at: string;
  source: MediaAssetSource;
  source_ref: string | null;
}

interface MediaUploadSessionRow {
  session_id: string;
  kind: MediaAssetKind;
  school_key: string;
  school_name: string;
  filename: string;
  total_size: number;
  submitted_at: string;
  submission_id: string;
  temp_r2_key: string;
  r2_upload_id: string;
  part_size: number;
  content_type: string | null;
  created_at: string;
  expires_at: string;
}

interface R2HeadLike {
  size: number;
  uploaded: Date;
  httpEtag: string;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

interface PreparedUploadBody {
  stream: ReadableStream<Uint8Array>;
  completion: Promise<number>;
  cancel(reason?: unknown): Promise<void>;
  contentType: string;
  length: number;
}

interface FixedLengthStreamPair {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

interface FixedLengthStreamConstructor {
  new(expectedLength: number): FixedLengthStreamPair;
}

export class MediaAssetApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MediaAssetApiError";
  }
}

export const MAX_POSTER_BYTES = 200 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
export const MEDIA_MULTIPART_PART_BYTES = 8 * 1024 * 1024;

const MAX_SCHOOL_NAME_BYTES = 300;
const MAX_FILENAME_BYTES = 512;
const MAX_SUBMISSION_ID_BYTES = 256;
const MAX_SOURCE_REF_BYTES = 512;
const MAX_HEADER_VALUE_LENGTH = 2048;
const HEADER_SNIFF_BYTES = 16;
const MEDIA_UPLOAD_SESSION_HOURS = 24;
const schemaPromises = new WeakMap<object, Promise<void>>();
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function mediaJson(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(data), { status, headers });
}

function mediaErrorResponse(error: MediaAssetApiError): Response {
  return mediaJson({ ok: false, error: { code: error.code, message: error.message } }, error.status);
}

function methodNotAllowed(allowed: string[]): Response {
  return mediaJson({
    ok: false,
    error: { code: "method_not_allowed", message: `此接口仅支持 ${allowed.join("、")} 请求。` },
  }, 405, { Allow: allowed.join(", ") });
}

export function isMediaAssetKind(value: string): value is MediaAssetKind {
  return value === "poster" || value === "video";
}

function requireKind(value: string): MediaAssetKind {
  if (!isMediaAssetKind(value)) {
    throw new MediaAssetApiError(400, "invalid_media_kind", "文件类别必须是 poster 或 video。");
  }
  return value;
}

function utf8Length(value: string): number {
  return encoder.encode(value).byteLength;
}

function hasAsciiControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function normalizeUserId(value: string): string {
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > 200 || utf8Length(normalized) > 512 || hasAsciiControl(normalized)) {
    throw new MediaAssetApiError(500, "invalid_storage_user", "共享存储标识配置不正确。");
  }
  return normalized;
}

function normalizeSchoolName(value: string | null): string {
  if (value === null) throw new MediaAssetApiError(400, "school_name_required", "缺少学校名称 schoolName。");
  const normalized = normalizeCompetitionSchoolName(value);
  if (
    !normalized || normalized.length > 200 || utf8Length(normalized) > MAX_SCHOOL_NAME_BYTES ||
    hasAsciiControl(normalized)
  ) {
    throw new MediaAssetApiError(400, "invalid_school_name", "schoolName 格式不正确或过长。");
  }
  return normalized;
}

function canonicalSchoolKey(schoolName: string): string {
  const key = schoolName
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
  if (!key || key.length > 160 || utf8Length(key) > MAX_SCHOOL_NAME_BYTES || !/^[\p{L}\p{N}\p{M}]+$/u.test(key)) {
    throw new MediaAssetApiError(400, "invalid_school_name", "学校名称无法生成有效标识。");
  }
  return key;
}

function normalizeSchoolKey(value: string): string {
  let decoded = value;
  if (value.includes("%")) {
    try {
      decoded = decodeURIComponent(value);
    } catch {
      throw new MediaAssetApiError(400, "invalid_school_key", "学校标识无法识别。");
    }
  }
  const normalized = decoded.normalize("NFKC").toLocaleLowerCase("zh-CN");
  if (
    !normalized || normalized.length > 160 || utf8Length(normalized) > MAX_SCHOOL_NAME_BYTES ||
    !/^[\p{L}\p{N}\p{M}]+$/u.test(normalized)
  ) {
    throw new MediaAssetApiError(400, "invalid_school_key", "学校标识格式不正确。");
  }
  return normalized;
}

function normalizeSubmittedAt(value: string | null): string {
  if (value === null || !value.trim()) {
    throw new MediaAssetApiError(400, "submitted_at_required", "缺少提交时间 submittedAt。");
  }
  const timestamp = Date.parse(value.trim());
  if (!Number.isFinite(timestamp)) {
    throw new MediaAssetApiError(400, "invalid_submitted_at", "submittedAt 不是有效日期。");
  }
  return new Date(timestamp).toISOString();
}

function normalizeSubmissionId(value: string | null): string {
  if (value === null) throw new MediaAssetApiError(400, "submission_id_required", "缺少提交编号 submissionId。");
  const normalized = value.normalize("NFKC").trim();
  if (
    !normalized || normalized.length > 200 || utf8Length(normalized) > MAX_SUBMISSION_ID_BYTES ||
    hasAsciiControl(normalized) || normalized.includes("/") || normalized.includes("\\")
  ) {
    throw new MediaAssetApiError(400, "invalid_submission_id", "submissionId 格式不正确或过长。");
  }
  return normalized;
}

function normalizeSource(value: MediaAssetSource): MediaAssetSource {
  if (value !== "web" && value !== "email") {
    throw new MediaAssetApiError(500, "invalid_media_source", "媒体来源配置不正确。");
  }
  return value;
}

function normalizeSourceRef(value: string | null | undefined): string | null {
  if (value === null || value === undefined || !value.trim()) return null;
  const normalized = value.normalize("NFKC").trim();
  if (
    normalized.length > 400 || utf8Length(normalized) > MAX_SOURCE_REF_BYTES ||
    hasAsciiControl(normalized)
  ) {
    throw new MediaAssetApiError(500, "invalid_media_source_ref", "媒体来源标识配置不正确。");
  }
  return normalized;
}

function normalizeFilename(value: string): string {
  const normalized = value.normalize("NFKC").trim();
  if (
    !normalized || normalized === "." || normalized === ".." || normalized.length > 240 ||
    utf8Length(normalized) > MAX_FILENAME_BYTES || hasAsciiControl(normalized) ||
    normalized.includes("/") || normalized.includes("\\")
  ) {
    throw new MediaAssetApiError(400, "invalid_filename", "文件名格式不正确或过长。");
  }
  return normalized;
}

function singleQueryParam(url: URL, name: string): string | null {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) {
    throw new MediaAssetApiError(400, "duplicate_parameter", `${name} 只能提供一次。`);
  }
  return values[0] ?? null;
}

function decodeHeaderFilename(value: string, source: string): string {
  if (!value || value.length > MAX_HEADER_VALUE_LENGTH) {
    throw new MediaAssetApiError(400, "invalid_filename", `${source} 中的文件名无效。`);
  }
  try {
    return decodeURIComponent(value);
  } catch {
    throw new MediaAssetApiError(400, "invalid_filename", `${source} 中的文件名编码无效。`);
  }
}

function filenameFromContentDisposition(value: string): string | null {
  if (!value || value.length > MAX_HEADER_VALUE_LENGTH || /[\r\n\0]/u.test(value)) return null;

  const extended = value.match(/(?:^|;)\s*filename\*\s*=\s*UTF-8''([^;]+)/iu);
  if (extended) {
    const encoded = extended[1].trim().replace(/^"|"$/gu, "");
    return decodeHeaderFilename(encoded, "Content-Disposition");
  }

  const quoted = value.match(/(?:^|;)\s*filename\s*=\s*"((?:\\.|[^"\\])*)"/iu);
  if (quoted) return quoted[1].replace(/\\(.)/gu, "$1");
  const token = value.match(/(?:^|;)\s*filename\s*=\s*([^;\s]+)/iu);
  return token?.[1] ?? null;
}

function readFilename(request: Request, url: URL): string {
  const encodedHeader = request.headers.get("X-File-Name");
  if (encodedHeader !== null) {
    return normalizeFilename(decodeHeaderFilename(encodedHeader, "X-File-Name"));
  }
  const disposition = request.headers.get("Content-Disposition");
  if (disposition) {
    const filename = filenameFromContentDisposition(disposition);
    if (filename) return normalizeFilename(filename);
  }
  const queryFilename = singleQueryParam(url, "filename");
  if (queryFilename !== null) return normalizeFilename(queryFilename);
  throw new MediaAssetApiError(400, "filename_required", "缺少文件名，请提供 X-File-Name。");
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot < 0 ? "" : filename.slice(dot).toLocaleLowerCase("en-US");
}

function validateExtension(filename: string, kind: MediaAssetKind): string {
  const extension = extensionOf(filename);
  const archives = [".zip", ".7z", ".rar"];
  if (kind === "poster" && ![".ai", ".jpg", ".jpeg", ...archives].includes(extension)) {
    throw new MediaAssetApiError(415, "poster_format_required", "海报仅支持 .ai、.jpg、.jpeg、.zip、.7z 或 .rar 文件。");
  }
  if (kind === "video" && ![".mp4", ...archives].includes(extension)) {
    throw new MediaAssetApiError(415, "video_format_required", "视频仅支持 .mp4、.zip、.7z 或 .rar 文件。");
  }
  return extension;
}

function startsWithAscii(bytes: Uint8Array, expected: string): boolean {
  if (bytes.byteLength < expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[index] !== expected.charCodeAt(index)) return false;
  }
  return true;
}

function detectedContentType(kind: MediaAssetKind, extension: string, header: Uint8Array): string {
  if (extension === ".zip") {
    const valid = header.byteLength >= 4
      && header[0] === 0x50 && header[1] === 0x4b
      && ((header[2] === 0x03 && header[3] === 0x04)
        || (header[2] === 0x05 && header[3] === 0x06)
        || (header[2] === 0x07 && header[3] === 0x08));
    if (valid) return "application/zip";
    throw new MediaAssetApiError(415, "invalid_zip_header", "ZIP 压缩包文件头不正确，文件可能已损坏或并非 ZIP。");
  }
  if (extension === ".7z") {
    const signature = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];
    if (signature.every((value, index) => header[index] === value)) return "application/x-7z-compressed";
    throw new MediaAssetApiError(415, "invalid_7z_header", "7z 压缩包文件头不正确，文件可能已损坏或并非 7z。");
  }
  if (extension === ".rar") {
    const common = header.byteLength >= 7
      && header[0] === 0x52 && header[1] === 0x61 && header[2] === 0x72
      && header[3] === 0x21 && header[4] === 0x1a && header[5] === 0x07;
    if (common && (header[6] === 0x00 || (header[6] === 0x01 && header[7] === 0x00))) {
      return "application/vnd.rar";
    }
    throw new MediaAssetApiError(415, "invalid_rar_header", "RAR 压缩包文件头不正确，文件可能已损坏或并非 RAR。");
  }
  if (kind === "poster") {
    if (extension === ".jpg" || extension === ".jpeg") {
      if (header.byteLength >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return "image/jpeg";
      throw new MediaAssetApiError(415, "invalid_jpeg_header", "JPG 文件头不正确，文件可能并非 JPEG 图片。");
    }
    if (startsWithAscii(header, "%PDF-")) return "application/pdf";
    if (startsWithAscii(header, "%!PS-Adobe")) return "application/postscript";
    throw new MediaAssetApiError(415, "invalid_ai_header", "AI 文件必须是 PDF-compatible 或 PostScript 格式。");
  }

  if (
    header.byteLength >= 8 && header[4] === 0x66 && header[5] === 0x74 &&
    header[6] === 0x79 && header[7] === 0x70
  ) {
    const boxSize = ((header[0] << 24) | (header[1] << 16) | (header[2] << 8) | header[3]) >>> 0;
    if (boxSize === 0 || boxSize === 1 || boxSize >= 8) return "video/mp4";
  }
  throw new MediaAssetApiError(415, "invalid_mp4_header", "MP4 文件头缺少有效的 ftyp 标记。");
}

/** Shared signature validator used by browser uploads and mail imports. */
export function validateMediaAssetSignature(
  kind: MediaAssetKind,
  filename: string,
  header: Uint8Array,
): { filename: string; contentType: string } {
  const normalizedKind = requireKind(kind);
  const normalizedFilename = normalizeFilename(filename);
  const extension = validateExtension(normalizedFilename, normalizedKind);
  return {
    filename: normalizedFilename,
    contentType: detectedContentType(normalizedKind, extension, header.subarray(0, HEADER_SNIFF_BYTES)),
  };
}

function readDeclaredLength(request: Request, maximum: number): number {
  const raw = request.headers.get("Content-Length");
  if (raw === null) {
    throw new MediaAssetApiError(411, "content_length_required", "上传文件必须提供 Content-Length，以便安全地流式写入云存储。");
  }
  if (!/^\d+$/u.test(raw)) throw new MediaAssetApiError(400, "invalid_content_length", "Content-Length 格式不正确。");
  const length = Number(raw);
  if (!Number.isSafeInteger(length)) throw new MediaAssetApiError(400, "invalid_content_length", "Content-Length 格式不正确。");
  if (length <= 0) throw new MediaAssetApiError(400, "empty_file", "上传的文件为空。");
  if (length > maximum) throw new MediaAssetApiError(413, "file_too_large", `文件不能超过 ${maximum / 1024 / 1024}MB。`);
  return length;
}

async function prepareUploadBody(request: Request, kind: MediaAssetKind, filename: string): Promise<PreparedUploadBody> {
  const maximum = kind === "poster" ? MAX_POSTER_BYTES : MAX_VIDEO_BYTES;
  const declaredLength = readDeclaredLength(request, maximum);
  const contentEncoding = request.headers.get("Content-Encoding")?.trim().toLocaleLowerCase("en-US");
  if (contentEncoding && contentEncoding !== "identity") {
    throw new MediaAssetApiError(415, "content_encoding_not_supported", "上传文件不能使用压缩的 HTTP Content-Encoding。");
  }
  if (!request.body) throw new MediaAssetApiError(400, "file_required", "请选择要上传的文件。");

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = request.body.getReader();
  } catch {
    throw new MediaAssetApiError(400, "upload_stream_unavailable", "上传文件流已被读取，请重新选择文件上传。");
  }

  const buffered: Uint8Array[] = [];
  let totalRead = 0;
  let prefixLength = 0;
  try {
    while (prefixLength < HEADER_SNIFF_BYTES) {
      const result = await reader.read();
      if (result.done) break;
      if (!result.value.byteLength) continue;
      totalRead += result.value.byteLength;
      if (totalRead > maximum) throw new MediaAssetApiError(413, "file_too_large", `文件不能超过 ${maximum / 1024 / 1024}MB。`);
      if (totalRead > declaredLength) {
        throw new MediaAssetApiError(400, "content_length_mismatch", "实际上传大小超过 Content-Length。");
      }
      buffered.push(result.value);
      prefixLength += result.value.byteLength;
    }
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      // The validation error is more useful than a transport cancellation error.
    }
    throw error;
  }

  if (totalRead === 0) {
    await reader.cancel().catch(() => undefined);
    throw new MediaAssetApiError(400, "empty_file", "上传的文件为空。");
  }

  const header = new Uint8Array(Math.min(prefixLength, HEADER_SNIFF_BYTES));
  let headerOffset = 0;
  for (const chunk of buffered) {
    if (headerOffset >= header.byteLength) break;
    const remaining = header.byteLength - headerOffset;
    header.set(chunk.subarray(0, remaining), headerOffset);
    headerOffset += Math.min(chunk.byteLength, remaining);
  }

  let contentType: string;
  try {
    contentType = validateMediaAssetSignature(kind, filename, header).contentType;
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }

  let resolveCompletion!: (size: number) => void;
  let rejectCompletion!: (error: unknown) => void;
  let settled = false;
  const completion = new Promise<number>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  // A conditional R2 write can reject before consuming the body. Keep that
  // best-effort cancellation from becoming an unhandled promise rejection.
  void completion.catch(() => undefined);

  const finish = (): void => {
    if (settled) return;
    settled = true;
    if (totalRead !== declaredLength) {
      rejectCompletion(new MediaAssetApiError(400, "content_length_mismatch", "实际上传大小与 Content-Length 不一致。"));
      return;
    }
    resolveCompletion(totalRead);
  };
  const fail = (error: unknown): void => {
    if (settled) return;
    settled = true;
    rejectCompletion(error);
  };

  let bufferedIndex = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (bufferedIndex < buffered.length) {
          controller.enqueue(buffered[bufferedIndex]);
          bufferedIndex += 1;
          return;
        }
        const result = await reader.read();
        if (result.done) {
          if (totalRead !== declaredLength) {
            const error = new MediaAssetApiError(400, "content_length_mismatch", "实际上传大小与 Content-Length 不一致。");
            fail(error);
            controller.error(error);
            return;
          }
          finish();
          controller.close();
          return;
        }
        if (!result.value.byteLength) return;
        totalRead += result.value.byteLength;
        if (totalRead > maximum) {
          const error = new MediaAssetApiError(413, "file_too_large", `文件不能超过 ${maximum / 1024 / 1024}MB。`);
          fail(error);
          controller.error(error);
          await reader.cancel(error).catch(() => undefined);
          return;
        }
        if (totalRead > declaredLength) {
          const error = new MediaAssetApiError(400, "content_length_mismatch", "实际上传大小超过 Content-Length。");
          fail(error);
          controller.error(error);
          await reader.cancel(error).catch(() => undefined);
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        fail(error);
        controller.error(error);
      }
    },
    async cancel(reason) {
      fail(reason ?? new MediaAssetApiError(409, "upload_cancelled", "上传被取消，请重试。"));
      await reader.cancel(reason).catch(() => undefined);
    },
  });

  return {
    stream,
    completion,
    contentType,
    length: declaredLength,
    async cancel(reason?: unknown) {
      fail(reason ?? new MediaAssetApiError(409, "upload_cancelled", "上传被取消，请重试。"));
      await reader.cancel(reason).catch(() => undefined);
      try {
        await stream.cancel(reason);
      } catch {
        // R2 may still briefly own the stream lock after a failed condition.
      }
    },
  };
}

function createFixedLengthStream(expectedLength: number): FixedLengthStreamPair {
  const constructor = (globalThis as unknown as { FixedLengthStream?: FixedLengthStreamConstructor }).FixedLengthStream;
  if (!constructor) {
    throw new MediaAssetApiError(503, "fixed_length_stream_unavailable", "当前运行环境暂不支持安全的大文件流式上传。");
  }
  return new constructor(expectedLength);
}

function compareSubmissionIds(left: string, right: string): number {
  if (/^\d+$/u.test(left) && /^\d+$/u.test(right)) {
    const normalizedLeft = left.replace(/^0+(?=\d)/u, "");
    const normalizedRight = right.replace(/^0+(?=\d)/u, "");
    if (normalizedLeft.length !== normalizedRight.length) return normalizedLeft.length > normalizedRight.length ? 1 : -1;
    if (normalizedLeft !== normalizedRight) return normalizedLeft > normalizedRight ? 1 : -1;
    return 0;
  }
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

function compareVersion(
  submittedAt: string,
  submissionId: string,
  current: Pick<MediaAssetRow, "submitted_at" | "submission_id">,
): number {
  const incomingTime = Date.parse(submittedAt);
  const currentTime = Date.parse(current.submitted_at);
  if (incomingTime !== currentTime) return incomingTime > currentTime ? 1 : -1;
  return compareSubmissionIds(submissionId, current.submission_id);
}

function conditionalWrite(current: R2HeadLike | null): MediaR2Conditional {
  if (!current) return { etagDoesNotMatch: "*" };
  const etag = current.httpEtag.trim();
  const unquoted = etag.length >= 2 && etag.startsWith('"') && etag.endsWith('"')
    ? etag.slice(1, -1)
    : etag;
  if (!unquoted) throw new MediaAssetApiError(409, "invalid_r2_etag", "共享文件版本标识无效，请重新采集后重试。");
  // R2's structured conditional accepts the raw ETag value; unlike an HTTP
  // If-Match header it must not include surrounding quotation marks.
  return { etagMatches: unquoted };
}

function mediaAssetFromRow(row: MediaAssetRow): MediaAsset {
  return {
    kind: row.kind,
    schoolKey: row.school_key,
    schoolName: row.school_name,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    submittedAt: row.submitted_at,
    submissionId: row.submission_id,
    uploadedAt: row.uploaded_at,
    source: row.source,
    sourceRef: row.source_ref,
    downloadUrl: `/api/media/${row.kind}/${encodeURIComponent(row.school_key)}/download`,
  };
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function textToBase64Url(value: string): string {
  return bytesToBase64Url(encoder.encode(value));
}

function base64UrlToText(value: string, maximumBytes: number): string | null {
  if (!value || value.length > Math.ceil(maximumBytes * 4 / 3) + 4 || !/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const base64 = value.replace(/-/gu, "+").replace(/_/gu, "/");
    const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
    if (binary.length > maximumBytes) return null;
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

function validRecoveredContentType(kind: MediaAssetKind, contentType: string): boolean {
  const archives = ["application/zip", "application/x-7z-compressed", "application/vnd.rar"];
  return kind === "poster"
    ? ["image/jpeg", "application/pdf", "application/postscript", ...archives].includes(contentType)
    : contentType === "video/mp4" || archives.includes(contentType);
}

function mediaRowFromR2(
  object: R2HeadLike,
  r2Key: string,
  schoolKey: string,
  expectedKind: MediaAssetKind,
): MediaAssetRow | null {
  const metadata = object.customMetadata;
  if (!metadata || metadata.encoding !== "b64url-utf8-v1" || metadata.kind !== expectedKind) return null;
  const schoolNameValue = base64UrlToText(metadata.schoolNameB64, MAX_SCHOOL_NAME_BYTES);
  const filenameValue = base64UrlToText(metadata.filenameB64, MAX_FILENAME_BYTES);
  const submissionIdValue = base64UrlToText(metadata.submissionIdB64, MAX_SUBMISSION_ID_BYTES);
  if (!schoolNameValue || !filenameValue || !submissionIdValue || !metadata.submittedAt || !metadata.contentType) return null;

  try {
    const schoolName = normalizeSchoolName(schoolNameValue);
    if (canonicalSchoolKey(schoolName) !== schoolKey) return null;
    const filename = normalizeFilename(filenameValue);
    validateExtension(filename, expectedKind);
    const submissionId = normalizeSubmissionId(submissionIdValue);
    const submittedAt = normalizeSubmittedAt(metadata.submittedAt);
    const uploadedTimestamp = Date.parse(metadata.uploadedAt ?? "");
    const uploadedAt = Number.isFinite(uploadedTimestamp)
      ? new Date(uploadedTimestamp).toISOString()
      : object.uploaded.toISOString();
    const contentType = metadata.contentType;
    const source: MediaAssetSource = metadata.source === "email" ? "email" : "web";
    const sourceRef = metadata.sourceRefB64
      ? base64UrlToText(metadata.sourceRefB64, MAX_SOURCE_REF_BYTES)
      : null;
    if (metadata.sourceRefB64 && sourceRef === null) return null;
    const maximum = expectedKind === "poster" ? MAX_POSTER_BYTES : MAX_VIDEO_BYTES;
    if (!validRecoveredContentType(expectedKind, contentType) || object.size <= 0 || object.size > maximum) return null;
    return {
      kind: expectedKind,
      school_key: schoolKey,
      school_name: schoolName,
      r2_key: r2Key,
      filename,
      content_type: contentType,
      size: object.size,
      submitted_at: submittedAt,
      submission_id: submissionId,
      uploaded_at: uploadedAt,
      source,
      source_ref: sourceRef,
    };
  } catch {
    return null;
  }
}

function arrayBufferForCrypto(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = encoder.encode(value);
  const digest = await crypto.subtle.digest("SHA-256", arrayBufferForCrypto(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function currentR2Key(userId: string, kind: MediaAssetKind, schoolKey: string): Promise<string> {
  const [storageUser, storageSchool] = await Promise.all([
    sha256Hex(`chemecar-user-v1:${userId}`),
    sha256Hex(`chemecar-school-v1:${schoolKey}`),
  ]);
  return `users/${storageUser.slice(0, 32)}/media/${kind}/${storageSchool}/current`;
}

export async function ensureMediaAssetsSchema(db: MediaD1Database): Promise<void> {
  const cacheKey = db as unknown as object;
  const existing = schemaPromises.get(cacheKey);
  if (existing) return existing;

  const pending = (async () => {
    await db.batch([
      db.prepare(`
        CREATE TABLE IF NOT EXISTS shared_media_assets (
          user_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('poster', 'video')),
          school_key TEXT NOT NULL,
          school_name TEXT NOT NULL,
          r2_key TEXT NOT NULL,
          filename TEXT NOT NULL,
          content_type TEXT NOT NULL,
          size INTEGER NOT NULL CHECK (
            size > 0 AND size <= 209715200
          ),
          submitted_at TEXT NOT NULL,
          submission_id TEXT NOT NULL,
          uploaded_at TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web', 'email')),
          source_ref TEXT,
          PRIMARY KEY (user_id, kind, school_key)
        )
      `),
      db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_shared_media_assets_user_kind_school_name
        ON shared_media_assets (user_id, kind, school_name COLLATE NOCASE)
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS media_collector_settings (
          user_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('poster', 'video')),
          starts_at TEXT,
          run_time TEXT NOT NULL DEFAULT '09:00',
          timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
          interval_minutes INTEGER NOT NULL DEFAULT 1440,
          enabled INTEGER NOT NULL DEFAULT 0,
          next_run_at TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (user_id, kind)
        )
      `),
      db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_media_collector_settings_enabled_next_run
        ON media_collector_settings (enabled, next_run_at)
        WHERE enabled = 1
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS media_upload_sessions (
          user_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('poster', 'video')),
          school_key TEXT NOT NULL,
          school_name TEXT NOT NULL,
          filename TEXT NOT NULL,
          total_size INTEGER NOT NULL CHECK (total_size > 0 AND total_size <= 209715200),
          submitted_at TEXT NOT NULL,
          submission_id TEXT NOT NULL,
          temp_r2_key TEXT NOT NULL,
          r2_upload_id TEXT NOT NULL,
          part_size INTEGER NOT NULL,
          content_type TEXT,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          PRIMARY KEY (user_id, session_id)
        )
      `),
      db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_media_upload_sessions_expires_at
        ON media_upload_sessions (expires_at)
      `),
    ]);
    const columns = await db.prepare("PRAGMA table_info(shared_media_assets)").all<{ name: string }>();
    const names = new Set(columns.results.map((column) => column.name));
    const upgrades: MediaD1PreparedStatement[] = [];
    if (!names.has("source")) {
      upgrades.push(db.prepare(
        "ALTER TABLE shared_media_assets ADD COLUMN source TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web', 'email'))",
      ));
    }
    if (!names.has("source_ref")) {
      upgrades.push(db.prepare("ALTER TABLE shared_media_assets ADD COLUMN source_ref TEXT"));
    }
    if (upgrades.length > 0) await db.batch(upgrades);
    await db.prepare("PRAGMA optimize").run();
  })();

  schemaPromises.set(cacheKey, pending);
  try {
    await pending;
  } catch (error) {
    schemaPromises.delete(cacheKey);
    throw error;
  }
}

async function getMediaRow(
  db: MediaD1Database,
  userId: string,
  kind: MediaAssetKind,
  schoolKey: string,
): Promise<MediaAssetRow | null> {
  return db.prepare(`
    SELECT kind, school_key, school_name, r2_key, filename, content_type, size,
           submitted_at, submission_id, uploaded_at, source, source_ref
    FROM shared_media_assets
    WHERE user_id = ? AND kind = ? AND school_key = ?
  `).bind(userId, kind, schoolKey).first<MediaAssetRow>();
}

async function persistMediaRow(db: MediaD1Database, userId: string, row: MediaAssetRow): Promise<void> {
  await db.prepare(`
    INSERT INTO shared_media_assets (
      user_id, kind, school_key, school_name, r2_key, filename, content_type,
      size, submitted_at, submission_id, uploaded_at, source, source_ref
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, kind, school_key) DO UPDATE SET
      school_name = excluded.school_name,
      r2_key = excluded.r2_key,
      filename = excluded.filename,
      content_type = excluded.content_type,
      size = excluded.size,
      submitted_at = excluded.submitted_at,
      submission_id = excluded.submission_id,
      uploaded_at = excluded.uploaded_at,
      source = excluded.source,
      source_ref = excluded.source_ref
    WHERE excluded.submitted_at > shared_media_assets.submitted_at
       OR (
         excluded.submitted_at = shared_media_assets.submitted_at
         AND CASE
           WHEN excluded.submission_id <> ''
            AND shared_media_assets.submission_id <> ''
            AND excluded.submission_id NOT GLOB '*[^0-9]*'
            AND shared_media_assets.submission_id NOT GLOB '*[^0-9]*'
           THEN CASE
             WHEN LENGTH(LTRIM(excluded.submission_id, '0')) <> LENGTH(LTRIM(shared_media_assets.submission_id, '0'))
             THEN LENGTH(LTRIM(excluded.submission_id, '0')) > LENGTH(LTRIM(shared_media_assets.submission_id, '0'))
             ELSE LTRIM(excluded.submission_id, '0') > LTRIM(shared_media_assets.submission_id, '0')
           END
           ELSE excluded.submission_id > shared_media_assets.submission_id
         END
       )
  `).bind(
    userId,
    row.kind,
    row.school_key,
    row.school_name,
    row.r2_key,
    row.filename,
    row.content_type,
    row.size,
    row.submitted_at,
    row.submission_id,
    row.uploaded_at,
    row.source,
    row.source_ref,
  ).run();
}

export async function listMediaAssets(
  db: MediaD1Database,
  userId: string,
  kind: MediaAssetKind,
): Promise<MediaAsset[]> {
  const normalizedUserId = normalizeUserId(userId);
  const normalizedKind = requireKind(kind);
  await ensureMediaAssetsSchema(db);
  const result = await db.prepare(`
    SELECT kind, school_key, school_name, r2_key, filename, content_type, size,
           submitted_at, submission_id, uploaded_at, source, source_ref
    FROM shared_media_assets
    WHERE user_id = ? AND kind = ?
    ORDER BY school_name COLLATE NOCASE ASC, submitted_at DESC, submission_id DESC
  `).bind(normalizedUserId, normalizedKind).all<MediaAssetRow>();
  return result.results.map(mediaAssetFromRow);
}

function currentResponse(asset: MediaAsset, reason: "duplicate" | "older-or-equal"): Response {
  const message = reason === "duplicate"
    ? "相同版本已经收集，文件未重复覆盖。"
    : "该文件不是此学校的更新版本，当前文件未被覆盖。";
  return mediaJson({ ok: true, accepted: false, reason, message, asset });
}

function calendarDateInTimezone(timestamp: string, timezone: string): string {
  const date = new Date(timestamp);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function enforceMediaCollectionStart(
  db: MediaD1Database,
  userId: string,
  kind: MediaAssetKind,
  submittedAt: string,
): Promise<void> {
  const setting = await db.prepare(`
    SELECT starts_at, timezone
    FROM media_collector_settings
    WHERE user_id = ? AND kind = ?
  `).bind(userId, kind).first<{ starts_at: string | null; timezone: string }>();
  if (!setting?.starts_at) return;
  let submittedDate: string;
  try {
    submittedDate = calendarDateInTimezone(submittedAt, setting.timezone || "Asia/Shanghai");
  } catch {
    throw new MediaAssetApiError(500, "invalid_media_schedule", "媒体采集起始日期的时区配置无效，请重新保存计划。");
  }
  if (submittedDate < setting.starts_at) {
    throw new MediaAssetApiError(
      422,
      "before_collection_start",
      `该文件提交日期早于${kind === "poster" ? "海报" : "视频"}栏目设置的收集起始日期，文件未收集。`,
    );
  }
}

function normalizeTotalSize(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new MediaAssetApiError(400, "invalid_file_size", "文件大小必须是正整数。");
  }
  if ((value as number) > maximum) {
    throw new MediaAssetApiError(413, "file_too_large", `文件不能超过 ${maximum / 1024 / 1024}MB。`);
  }
  return value as number;
}

async function readSmallJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("Content-Type")?.toLocaleLowerCase("en-US").includes("application/json")) {
    throw new MediaAssetApiError(415, "unsupported_media_type", "分片上传设置必须使用 JSON 格式。");
  }
  const declared = request.headers.get("Content-Length");
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > 16 * 1024)) {
    throw new MediaAssetApiError(413, "request_too_large", "分片上传设置内容过大。");
  }
  const text = await request.text();
  if (encoder.encode(text).byteLength > 16 * 1024) {
    throw new MediaAssetApiError(413, "request_too_large", "分片上传设置内容过大。");
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    return parsed as Record<string, unknown>;
  } catch {
    throw new MediaAssetApiError(400, "invalid_json", "分片上传设置不是有效的 JSON 对象。");
  }
}

function normalizedSessionId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new MediaAssetApiError(400, "invalid_upload_session", "上传会话标识格式不正确。");
  }
  return value.toLocaleLowerCase("en-US");
}

async function getUploadSession(
  db: MediaD1Database,
  userId: string,
  sessionId: string,
  kind: MediaAssetKind,
): Promise<MediaUploadSessionRow> {
  const row = await db.prepare(`
    SELECT session_id, kind, school_key, school_name, filename, total_size,
           submitted_at, submission_id, temp_r2_key, r2_upload_id, part_size,
           content_type, created_at, expires_at
    FROM media_upload_sessions
    WHERE user_id = ? AND session_id = ? AND kind = ?
  `).bind(userId, sessionId, kind).first<MediaUploadSessionRow>();
  if (!row) throw new MediaAssetApiError(404, "upload_session_not_found", "分片上传会话不存在或已结束，请重新选择文件上传。");
  if (Date.parse(row.expires_at) <= Date.now()) {
    throw new MediaAssetApiError(410, "upload_session_expired", "分片上传会话已过期，请重新选择文件上传。");
  }
  return row;
}

async function discardUploadSession(
  env: MediaAssetsEnv,
  userId: string,
  row: MediaUploadSessionRow,
  abortIncomplete: boolean,
): Promise<void> {
  const temp = await env.FILES.head(row.temp_r2_key).catch(() => null);
  if (temp) await env.FILES.delete(row.temp_r2_key).catch(() => undefined);
  else if (abortIncomplete) {
    await env.FILES.resumeMultipartUpload(row.temp_r2_key, row.r2_upload_id).abort().catch(() => undefined);
  }
  await env.DB.prepare(
    "DELETE FROM media_upload_sessions WHERE user_id = ? AND session_id = ?",
  ).bind(userId, row.session_id).run();
}

async function createMediaMultipartUploadInternal(
  request: Request,
  env: MediaAssetsEnv,
  userId: string,
  kind: MediaAssetKind,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  const normalizedUserId = normalizeUserId(userId);
  const normalizedKind = requireKind(kind);
  await ensureMediaAssetsSchema(env.DB);
  const body = await readSmallJson(request);
  const filename = normalizeFilename(typeof body.filename === "string" ? body.filename : "");
  const explicitMetadata = [body.schoolName, body.submittedAt, body.submissionId]
    .some((value) => typeof value === "string" && value.trim().length > 0);
  let schoolName: string;
  let submittedAt: string;
  let submissionId: string;
  if (explicitMetadata) {
    schoolName = normalizeSchoolName(typeof body.schoolName === "string" ? body.schoolName : null);
    submittedAt = normalizeSubmittedAt(typeof body.submittedAt === "string" ? body.submittedAt : null);
    submissionId = normalizeSubmissionId(typeof body.submissionId === "string" ? body.submissionId : null);
  } else {
    try {
      ({ schoolName, submittedAt, submissionId } = manualFileMetadata(filename));
    } catch (error) {
      throw new MediaAssetApiError(
        400,
        "school_name_not_in_filename",
        error instanceof Error ? error.message : "无法从文件名识别学校，请重命名后重试。",
      );
    }
  }
  const schoolKey = canonicalSchoolKey(schoolName);
  validateExtension(filename, normalizedKind);
  const maximum = normalizedKind === "poster" ? MAX_POSTER_BYTES : MAX_VIDEO_BYTES;
  const totalSize = normalizeTotalSize(body.totalSize, maximum);
  if (explicitMetadata) await enforceMediaCollectionStart(env.DB, normalizedUserId, normalizedKind, submittedAt);

  const r2Key = await currentR2Key(normalizedUserId, normalizedKind, schoolKey);
  const [existing, currentObject] = await Promise.all([
    getMediaRow(env.DB, normalizedUserId, normalizedKind, schoolKey),
    env.FILES.head(r2Key),
  ]);
  const r2Row = currentObject ? mediaRowFromR2(currentObject, r2Key, schoolKey, normalizedKind) : null;
  if (r2Row && compareVersion(submittedAt, submissionId, r2Row) <= 0) {
    await persistMediaRow(env.DB, normalizedUserId, r2Row);
    const saved = await getMediaRow(env.DB, normalizedUserId, normalizedKind, schoolKey) ?? r2Row;
    return currentResponse(mediaAssetFromRow(saved), compareVersion(submittedAt, submissionId, r2Row) === 0 ? "duplicate" : "older-or-equal");
  }
  if (existing && compareVersion(submittedAt, submissionId, existing) < 0) {
    return currentResponse(mediaAssetFromRow(existing), "older-or-equal");
  }

  const sessionId = crypto.randomUUID();
  const storageUser = await sha256Hex(`chemecar-user-v1:${normalizedUserId}`);
  const tempR2Key = `users/${storageUser.slice(0, 32)}/media-uploads/${sessionId}`;
  const upload = await env.FILES.createMultipartUpload(tempR2Key, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { sessionId, kind: normalizedKind },
  });
  const created = new Date();
  const expires = new Date(created.getTime() + MEDIA_UPLOAD_SESSION_HOURS * 60 * 60 * 1000);
  try {
    await env.DB.prepare(`
      INSERT INTO media_upload_sessions (
        user_id, session_id, kind, school_key, school_name, filename, total_size,
        submitted_at, submission_id, temp_r2_key, r2_upload_id, part_size,
        content_type, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).bind(
      normalizedUserId, sessionId, normalizedKind, schoolKey, schoolName, filename, totalSize,
      submittedAt, submissionId, tempR2Key, upload.uploadId, MEDIA_MULTIPART_PART_BYTES,
      created.toISOString(), expires.toISOString(),
    ).run();
  } catch (error) {
    await upload.abort().catch(() => undefined);
    throw error;
  }
  return mediaJson({
    ok: true,
    accepted: true,
    sessionId,
    schoolName,
    submittedAt,
    submissionId,
    partSize: MEDIA_MULTIPART_PART_BYTES,
    partCount: Math.ceil(totalSize / MEDIA_MULTIPART_PART_BYTES),
    expiresAt: expires.toISOString(),
  }, 201);
}

export async function createMediaMultipartUpload(
  request: Request,
  env: MediaAssetsEnv,
  userId: string,
  kind: MediaAssetKind,
): Promise<Response> {
  try {
    return await createMediaMultipartUploadInternal(request, env, userId, kind);
  } catch (error) {
    if (error instanceof MediaAssetApiError) return mediaErrorResponse(error);
    throw error;
  }
}

async function uploadMediaMultipartPartInternal(
  request: Request,
  env: MediaAssetsEnv,
  userId: string,
  kind: MediaAssetKind,
  sessionIdValue: string,
  partNumberValue: string,
): Promise<Response> {
  if (request.method !== "PUT") return methodNotAllowed(["PUT"]);
  const normalizedUserId = normalizeUserId(userId);
  const normalizedKind = requireKind(kind);
  const sessionId = normalizedSessionId(sessionIdValue);
  const partNumber = Number(partNumberValue);
  await ensureMediaAssetsSchema(env.DB);
  const row = await getUploadSession(env.DB, normalizedUserId, sessionId, normalizedKind);
  const partCount = Math.ceil(row.total_size / row.part_size);
  if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > partCount) {
    throw new MediaAssetApiError(400, "invalid_part_number", "上传分片编号超出范围。");
  }
  const expectedLength = partNumber === partCount
    ? row.total_size - row.part_size * (partCount - 1)
    : row.part_size;
  const declaredLength = request.headers.get("Content-Length");
  if (!declaredLength || !/^\d+$/u.test(declaredLength) || Number(declaredLength) !== expectedLength) {
    throw new MediaAssetApiError(400, "part_size_mismatch", "上传分片大小与会话记录不一致，请重新上传该分片。");
  }
  if (!request.body) throw new MediaAssetApiError(400, "file_required", "上传分片内容为空。");
  const upload = env.FILES.resumeMultipartUpload(row.temp_r2_key, row.r2_upload_id);
  let value: ReadableStream<Uint8Array> | Uint8Array;
  let detectedType: string | null = null;
  if (partNumber === 1) {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength !== expectedLength) throw new MediaAssetApiError(400, "part_size_mismatch", "上传分片读取不完整，请重试。");
    detectedType = validateMediaAssetSignature(normalizedKind, row.filename, bytes.subarray(0, HEADER_SNIFF_BYTES)).contentType;
    value = bytes;
  } else {
    value = request.body;
  }
  const uploaded = await upload.uploadPart(partNumber, value);
  if (detectedType) {
    await env.DB.prepare(`
      UPDATE media_upload_sessions SET content_type = ?
      WHERE user_id = ? AND session_id = ? AND kind = ?
    `).bind(detectedType, normalizedUserId, sessionId, normalizedKind).run();
  }
  return mediaJson({ ok: true, partNumber: uploaded.partNumber, etag: uploaded.etag });
}

export async function uploadMediaMultipartPart(
  request: Request,
  env: MediaAssetsEnv,
  userId: string,
  kind: MediaAssetKind,
  sessionId: string,
  partNumber: string,
): Promise<Response> {
  try {
    return await uploadMediaMultipartPartInternal(request, env, userId, kind, sessionId, partNumber);
  } catch (error) {
    if (error instanceof MediaAssetApiError) return mediaErrorResponse(error);
    throw error;
  }
}

function metadataForStoredMedia(
  row: Pick<MediaUploadSessionRow, "kind" | "school_name" | "filename" | "submitted_at" | "submission_id">,
  contentType: string,
  uploadedAt: string,
): Record<string, string> {
  return {
    encoding: "b64url-utf8-v1",
    kind: row.kind,
    schoolNameB64: textToBase64Url(row.school_name),
    filenameB64: textToBase64Url(row.filename),
    contentType,
    submittedAt: row.submitted_at,
    submissionIdB64: textToBase64Url(row.submission_id),
    uploadedAt,
    source: "web",
    sourceRefB64: textToBase64Url(`web:${row.submission_id}`),
  };
}

async function completeMediaMultipartUploadInternal(
  request: Request,
  env: MediaAssetsEnv,
  userId: string,
  kind: MediaAssetKind,
  sessionIdValue: string,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  const normalizedUserId = normalizeUserId(userId);
  const normalizedKind = requireKind(kind);
  const sessionId = normalizedSessionId(sessionIdValue);
  await ensureMediaAssetsSchema(env.DB);
  const row = await getUploadSession(env.DB, normalizedUserId, sessionId, normalizedKind);
  await enforceMediaCollectionStart(env.DB, normalizedUserId, normalizedKind, row.submitted_at);
  const body = await readSmallJson(request);
  if (!Array.isArray(body.parts)) throw new MediaAssetApiError(400, "invalid_uploaded_parts", "缺少已上传分片清单。");
  const expectedPartCount = Math.ceil(row.total_size / row.part_size);
  const parts: MediaR2UploadedPart[] = body.parts.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new MediaAssetApiError(400, "invalid_uploaded_parts", "分片清单格式不正确。");
    }
    const part = entry as Record<string, unknown>;
    if (!Number.isSafeInteger(part.partNumber) || typeof part.etag !== "string" || part.etag.length < 1 || part.etag.length > 256 || /[\r\n\0]/u.test(part.etag)) {
      throw new MediaAssetApiError(400, "invalid_uploaded_parts", "分片编号或校验标识不正确。");
    }
    return { partNumber: part.partNumber as number, etag: part.etag };
  }).sort((left, right) => left.partNumber - right.partNumber);
  if (parts.length !== expectedPartCount || parts.some((part, index) => part.partNumber !== index + 1)) {
    throw new MediaAssetApiError(400, "incomplete_uploaded_parts", "文件分片尚未全部上传，请重试缺失分片。");
  }
  if (!row.content_type || !validRecoveredContentType(normalizedKind, row.content_type)) {
    throw new MediaAssetApiError(400, "first_part_required", "首个分片尚未完成格式检查，请重新上传首个分片。");
  }

  const currentKey = await currentR2Key(normalizedUserId, normalizedKind, row.school_key);
  const [existing, initialCurrentObject] = await Promise.all([
    getMediaRow(env.DB, normalizedUserId, normalizedKind, row.school_key),
    env.FILES.head(currentKey),
  ]);
  let currentObject = initialCurrentObject;
  let currentStoredRow = currentObject ? mediaRowFromR2(currentObject, currentKey, row.school_key, normalizedKind) : null;
  if (currentStoredRow && compareVersion(row.submitted_at, row.submission_id, currentStoredRow) <= 0) {
    await persistMediaRow(env.DB, normalizedUserId, currentStoredRow);
    const saved = await getMediaRow(env.DB, normalizedUserId, normalizedKind, row.school_key) ?? currentStoredRow;
    await discardUploadSession(env, normalizedUserId, row, true);
    return currentResponse(mediaAssetFromRow(saved), compareVersion(row.submitted_at, row.submission_id, currentStoredRow) === 0 ? "duplicate" : "older-or-equal");
  }
  if (existing && compareVersion(row.submitted_at, row.submission_id, existing) < 0) {
    await discardUploadSession(env, normalizedUserId, row, true);
    return currentResponse(mediaAssetFromRow(existing), "older-or-equal");
  }

  let assembled = await env.FILES.head(row.temp_r2_key);
  if (!assembled) {
    const upload = env.FILES.resumeMultipartUpload(row.temp_r2_key, row.r2_upload_id);
    assembled = await upload.complete(parts);
  }
  if (assembled.size !== row.total_size) {
    throw new MediaAssetApiError(500, "stored_size_mismatch", "分片已合并，但云存储大小校验失败；请重试完成操作。");
  }
  const tempObject = await env.FILES.get(row.temp_r2_key);
  if (!tempObject || tempObject.size !== row.total_size) {
    throw new MediaAssetApiError(500, "assembled_file_missing", "分片已合并，但临时云文件读取失败；请重试完成操作。");
  }
  const uploadedAt = new Date().toISOString();
  const onlyIf = conditionalWrite(currentObject);
  const fixedLength = createFixedLengthStream(row.total_size);
  const copyPromise = tempObject.body.pipeTo(fixedLength.writable);
  void copyPromise.catch(() => undefined);
  let stored: MediaR2Object | null;
  try {
    stored = await env.FILES.put(currentKey, fixedLength.readable, {
      onlyIf,
      httpMetadata: { contentType: row.content_type },
      customMetadata: metadataForStoredMedia(row, row.content_type, uploadedAt),
    });
    if (stored) await copyPromise;
  } catch (error) {
    await fixedLength.readable.cancel(error).catch(() => undefined);
    await copyPromise.catch(() => undefined);
    throw error;
  }
  if (!stored) {
    const conflict = new MediaAssetApiError(409, "concurrent_update", "该学校正在接收另一份媒体文件。");
    await fixedLength.readable.cancel(conflict).catch(() => undefined);
    await copyPromise.catch(() => undefined);
    currentObject = await env.FILES.head(currentKey);
    currentStoredRow = currentObject ? mediaRowFromR2(currentObject, currentKey, row.school_key, normalizedKind) : null;
    if (currentStoredRow && compareVersion(row.submitted_at, row.submission_id, currentStoredRow) <= 0) {
      await persistMediaRow(env.DB, normalizedUserId, currentStoredRow);
      const saved = await getMediaRow(env.DB, normalizedUserId, normalizedKind, row.school_key) ?? currentStoredRow;
      await discardUploadSession(env, normalizedUserId, row, false);
      return currentResponse(mediaAssetFromRow(saved), compareVersion(row.submitted_at, row.submission_id, currentStoredRow) === 0 ? "duplicate" : "older-or-equal");
    }
    throw new MediaAssetApiError(409, "concurrent_update", "该学校正在接收另一份媒体文件，请稍后重试完成操作。");
  }
  const assetRow: MediaAssetRow = {
    kind: normalizedKind,
    school_key: row.school_key,
    school_name: row.school_name,
    r2_key: currentKey,
    filename: row.filename,
    content_type: row.content_type,
    size: row.total_size,
    submitted_at: row.submitted_at,
    submission_id: row.submission_id,
    uploaded_at: uploadedAt,
    source: "web",
    source_ref: `web:${row.submission_id}`,
  };
  await persistMediaRow(env.DB, normalizedUserId, assetRow);
  const saved = await getMediaRow(env.DB, normalizedUserId, normalizedKind, row.school_key);
  if (!saved) throw new MediaAssetApiError(500, "media_metadata_missing", "文件已保存，但共享索引更新失败；请重试完成操作。");
  await discardUploadSession(env, normalizedUserId, row, false);
  const accepted = compareVersion(row.submitted_at, row.submission_id, saved) === 0;
  return mediaJson({
    ok: true,
    accepted,
    ...(accepted ? {} : { reason: "superseded", message: "保存过程中收到了更新版本，系统已保留较新的文件。" }),
    asset: mediaAssetFromRow(saved),
  }, accepted && !existing && !currentStoredRow ? 201 : 200);
}

export async function completeMediaMultipartUpload(
  request: Request,
  env: MediaAssetsEnv,
  userId: string,
  kind: MediaAssetKind,
  sessionId: string,
): Promise<Response> {
  try {
    return await completeMediaMultipartUploadInternal(request, env, userId, kind, sessionId);
  } catch (error) {
    if (error instanceof MediaAssetApiError) return mediaErrorResponse(error);
    throw error;
  }
}

export async function abortMediaMultipartUpload(
  request: Request,
  env: MediaAssetsEnv,
  userId: string,
  kind: MediaAssetKind,
  sessionIdValue: string,
): Promise<Response> {
  try {
    if (request.method !== "DELETE") return methodNotAllowed(["DELETE"]);
    const normalizedUserId = normalizeUserId(userId);
    const normalizedKind = requireKind(kind);
    const sessionId = normalizedSessionId(sessionIdValue);
    await ensureMediaAssetsSchema(env.DB);
    const row = await getUploadSession(env.DB, normalizedUserId, sessionId, normalizedKind);
    await discardUploadSession(env, normalizedUserId, row, true);
    return mediaJson({ ok: true, aborted: true });
  } catch (error) {
    if (error instanceof MediaAssetApiError) return mediaErrorResponse(error);
    throw error;
  }
}

async function importMediaAssetBytes(
  env: MediaAssetsEnv,
  userId: string,
  input: StoredMediaAssetImportInput,
  bytes: Uint8Array,
): Promise<MediaAssetImportResult> {
  const normalizedUserId = normalizeUserId(userId);
  const kind = requireKind(input.kind);
  const schoolName = normalizeSchoolName(input.schoolName);
  const schoolKey = canonicalSchoolKey(schoolName);
  const submittedAt = normalizeSubmittedAt(input.submittedAt);
  const submissionId = normalizeSubmissionId(input.submissionId);
  const source = normalizeSource(input.source);
  const sourceRef = normalizeSourceRef(input.sourceRef);
  const maximum = kind === "poster" ? MAX_POSTER_BYTES : MAX_VIDEO_BYTES;
  if (bytes.byteLength < 1) throw new MediaAssetApiError(400, "empty_file", "媒体文件为空。");
  if (bytes.byteLength > maximum) {
    throw new MediaAssetApiError(413, "file_too_large", `文件不能超过 ${maximum / 1024 / 1024}MB。`);
  }
  const validated = validateMediaAssetSignature(kind, input.filename, bytes);
  await ensureMediaAssetsSchema(env.DB);
  await enforceMediaCollectionStart(env.DB, normalizedUserId, kind, submittedAt);
  const r2Key = await currentR2Key(normalizedUserId, kind, schoolKey);
  const [existing, currentObject] = await Promise.all([
    getMediaRow(env.DB, normalizedUserId, kind, schoolKey),
    env.FILES.head(r2Key),
  ]);
  const r2Row = currentObject
    ? mediaRowFromR2(currentObject as R2HeadLike, r2Key, schoolKey, kind)
    : null;

  if (r2Row && compareVersion(submittedAt, submissionId, r2Row) <= 0) {
    await persistMediaRow(env.DB, normalizedUserId, r2Row);
    const saved = await getMediaRow(env.DB, normalizedUserId, kind, schoolKey) ?? r2Row;
    return {
      accepted: false,
      reason: compareVersion(submittedAt, submissionId, r2Row) === 0 ? "duplicate" : "older-or-equal",
      asset: mediaAssetFromRow(saved),
    };
  }
  if (existing && compareVersion(submittedAt, submissionId, existing) < 0) {
    if (!r2Row || compareVersion(existing.submitted_at, existing.submission_id, r2Row) > 0) {
      throw new MediaAssetApiError(
        409,
        "stored_file_needs_latest_version",
        "索引中的最新媒体尚未完整写入存储，请稍后重试。",
      );
    }
    return { accepted: false, reason: "older-or-equal", asset: mediaAssetFromRow(existing) };
  }

  const uploadedAt = new Date().toISOString();
  const onlyIf = conditionalWrite(currentObject);
  const customMetadata: Record<string, string> = {
    encoding: "b64url-utf8-v1",
    kind,
    schoolNameB64: textToBase64Url(schoolName),
    filenameB64: textToBase64Url(validated.filename),
    contentType: validated.contentType,
    submittedAt,
    submissionIdB64: textToBase64Url(submissionId),
    uploadedAt,
    source,
  };
  if (sourceRef) customMetadata.sourceRefB64 = textToBase64Url(sourceRef);
  const stored = await env.FILES.put(r2Key, bytes, {
    onlyIf,
    httpMetadata: { contentType: validated.contentType },
    customMetadata,
  });
  if (!stored) {
    const latestObject = await env.FILES.head(r2Key);
    const latestRow = latestObject
      ? mediaRowFromR2(latestObject as R2HeadLike, r2Key, schoolKey, kind)
      : null;
    if (latestRow && compareVersion(submittedAt, submissionId, latestRow) <= 0) {
      await persistMediaRow(env.DB, normalizedUserId, latestRow);
      const saved = await getMediaRow(env.DB, normalizedUserId, kind, schoolKey) ?? latestRow;
      return {
        accepted: false,
        reason: compareVersion(submittedAt, submissionId, latestRow) === 0 ? "duplicate" : "older-or-equal",
        asset: mediaAssetFromRow(saved),
      };
    }
    throw new MediaAssetApiError(409, "concurrent_update", "该学校正在接收另一份媒体文件，请稍后重试。");
  }
  if (stored.size !== bytes.byteLength) {
    throw new MediaAssetApiError(500, "stored_size_mismatch", "媒体已上传，但云存储大小校验失败；请重试。");
  }
  const row: MediaAssetRow = {
    kind,
    school_key: schoolKey,
    school_name: schoolName,
    r2_key: r2Key,
    filename: validated.filename,
    content_type: validated.contentType,
    size: bytes.byteLength,
    submitted_at: submittedAt,
    submission_id: submissionId,
    uploaded_at: uploadedAt,
    source,
    source_ref: sourceRef,
  };
  await persistMediaRow(env.DB, normalizedUserId, row);
  const saved = await getMediaRow(env.DB, normalizedUserId, kind, schoolKey);
  if (!saved) throw new MediaAssetApiError(500, "media_metadata_missing", "媒体已保存，但共享索引更新失败；请重试。");
  const accepted = compareVersion(submittedAt, submissionId, saved) === 0;
  return {
    accepted,
    ...(accepted ? {} : { reason: "superseded" as const }),
    asset: mediaAssetFromRow(saved),
  };
}

/** Revalidates and imports an already-stored mail attachment into the shared library. */
export async function importStoredMediaAsset(
  env: MediaAssetsEnv,
  userId: string,
  sourceR2Key: string,
  input: StoredMediaAssetImportInput,
): Promise<MediaAssetImportResult> {
  if (!sourceR2Key || sourceR2Key.length > 2048 || /[\r\n\0]/u.test(sourceR2Key)) {
    throw new MediaAssetApiError(500, "invalid_media_source_object", "媒体来源文件标识不正确。");
  }
  const object = await env.FILES.get(sourceR2Key);
  if (!object) throw new MediaAssetApiError(404, "media_source_missing", "邮件附件已登记，但云端原文件未找到。");
  const maximum = input.kind === "poster" ? MAX_POSTER_BYTES : MAX_VIDEO_BYTES;
  if (object.size < 1 || object.size > maximum) {
    throw new MediaAssetApiError(413, "file_too_large", `文件不能超过 ${maximum / 1024 / 1024}MB。`);
  }
  const buffer = await object.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength !== object.size) {
    throw new MediaAssetApiError(502, "media_source_size_mismatch", "邮件附件读取不完整，请稍后重试。");
  }
  return importMediaAssetBytes(env, userId, input, bytes);
}

async function uploadMediaAssetInternal(
  request: Request,
  env: MediaAssetsEnv,
  userId: string,
  kind: MediaAssetKind,
  enforceConfiguredStart: boolean,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  const normalizedUserId = normalizeUserId(userId);
  const normalizedKind = requireKind(kind);
  await ensureMediaAssetsSchema(env.DB);

  const url = new URL(request.url);
  const schoolName = normalizeSchoolName(singleQueryParam(url, "schoolName"));
  const schoolKey = canonicalSchoolKey(schoolName);
  const submittedAt = normalizeSubmittedAt(singleQueryParam(url, "submittedAt"));
  const submissionId = normalizeSubmissionId(singleQueryParam(url, "submissionId"));
  const filename = readFilename(request, url);
  validateExtension(filename, normalizedKind);
  if (enforceConfiguredStart) {
    await enforceMediaCollectionStart(env.DB, normalizedUserId, normalizedKind, submittedAt);
  }
  const r2Key = await currentR2Key(normalizedUserId, normalizedKind, schoolKey);

  const [existing, currentObject] = await Promise.all([
    getMediaRow(env.DB, normalizedUserId, normalizedKind, schoolKey),
    env.FILES.head(r2Key),
  ]);
  const r2Row = currentObject
    ? mediaRowFromR2(currentObject as R2HeadLike, r2Key, schoolKey, normalizedKind)
    : null;

  if (r2Row && compareVersion(submittedAt, submissionId, r2Row) <= 0) {
    await persistMediaRow(env.DB, normalizedUserId, r2Row);
    const saved = await getMediaRow(env.DB, normalizedUserId, normalizedKind, schoolKey) ?? r2Row;
    const comparison = compareVersion(submittedAt, submissionId, r2Row);
    return currentResponse(mediaAssetFromRow(saved), comparison === 0 ? "duplicate" : "older-or-equal");
  }

  if (existing) {
    const comparison = compareVersion(submittedAt, submissionId, existing);
    if (comparison < 0) {
      if (!r2Row || compareVersion(existing.submitted_at, existing.submission_id, r2Row) > 0) {
        throw new MediaAssetApiError(
          409,
          "stored_file_needs_latest_version",
          "索引中的最新文件版本尚未完整写入存储，请重新提交当前最新版本。",
        );
      }
      return currentResponse(mediaAssetFromRow(existing), "older-or-equal");
    }
    // When D1 has this version but R2 is absent, older, or has invalid custom
    // metadata, the same upload is allowed to repair the blob and its version
    // marker. A valid equal R2 version already returned as a duplicate above.
  }

  const prepared = await prepareUploadBody(request, normalizedKind, filename);
  let fixedLength: FixedLengthStreamPair;
  try {
    fixedLength = createFixedLengthStream(prepared.length);
  } catch (error) {
    await prepared.cancel(error);
    throw error;
  }
  const pipePromise = prepared.stream.pipeTo(fixedLength.writable);
  void pipePromise.catch(() => undefined);
  const uploadedAt = new Date().toISOString();
  const onlyIf = conditionalWrite(currentObject);

  let stored: MediaR2Object | null;
  try {
    stored = await env.FILES.put(r2Key, fixedLength.readable, {
      onlyIf,
      httpMetadata: { contentType: prepared.contentType },
      customMetadata: {
        encoding: "b64url-utf8-v1",
        kind: normalizedKind,
        schoolNameB64: textToBase64Url(schoolName),
        filenameB64: textToBase64Url(filename),
        contentType: prepared.contentType,
        submittedAt,
        submissionIdB64: textToBase64Url(submissionId),
        uploadedAt,
        source: "web",
        sourceRefB64: textToBase64Url(`web:${submissionId}`),
      },
    });
    if (stored) await pipePromise;
  } catch (error) {
    await prepared.cancel(error);
    await fixedLength.readable.cancel(error).catch(() => undefined);
    try {
      await pipePromise;
    } catch (streamError) {
      if (streamError instanceof MediaAssetApiError) throw streamError;
    }
    throw error;
  }

  if (!stored) {
    const conflict = new MediaAssetApiError(409, "concurrent_update", "该学校正在接收另一份更新文件。");
    await fixedLength.readable.cancel(conflict).catch(() => undefined);
    await prepared.cancel(conflict);
    await pipePromise.catch(() => undefined);
    const latestObject = await env.FILES.head(r2Key);
    const latestRow = latestObject
      ? mediaRowFromR2(latestObject as R2HeadLike, r2Key, schoolKey, normalizedKind)
      : null;
    if (latestRow && compareVersion(submittedAt, submissionId, latestRow) <= 0) {
      await persistMediaRow(env.DB, normalizedUserId, latestRow);
      const saved = await getMediaRow(env.DB, normalizedUserId, normalizedKind, schoolKey) ?? latestRow;
      const comparison = compareVersion(submittedAt, submissionId, latestRow);
      return currentResponse(mediaAssetFromRow(saved), comparison === 0 ? "duplicate" : "older-or-equal");
    }
    throw new MediaAssetApiError(409, "concurrent_update", "该学校正在接收另一份文件，请稍后重试。");
  }

  const actualSize = await prepared.completion;
  if (stored.size !== actualSize) {
    throw new MediaAssetApiError(500, "stored_size_mismatch", "文件已上传，但存储大小校验失败；请重试以修复索引。");
  }
  const row: MediaAssetRow = {
    kind: normalizedKind,
    school_key: schoolKey,
    school_name: schoolName,
    r2_key: r2Key,
    filename,
    content_type: prepared.contentType,
    size: actualSize,
    submitted_at: submittedAt,
    submission_id: submissionId,
    uploaded_at: uploadedAt,
    source: "web",
    source_ref: `web:${submissionId}`,
  };
  // R2 is written first. If this D1 write fails, retrying the same version
  // reads the R2 metadata above and repairs the index without rewriting bytes.
  await persistMediaRow(env.DB, normalizedUserId, row);
  const saved = await getMediaRow(env.DB, normalizedUserId, normalizedKind, schoolKey);
  if (!saved) {
    throw new MediaAssetApiError(500, "media_metadata_missing", "文件已保存，但共享索引更新失败；请重试修复。");
  }
  const accepted = compareVersion(submittedAt, submissionId, saved) === 0;
  return mediaJson({
    ok: true,
    accepted,
    ...(accepted ? {} : {
      reason: "superseded",
      message: "保存过程中收到了更新版本，系统已保留较新的文件。",
    }),
    asset: mediaAssetFromRow(saved),
  }, accepted && !existing && !r2Row ? 201 : 200);
}

export async function uploadMediaAsset(
  request: Request,
  env: MediaAssetsEnv,
  userId: string,
  kind: MediaAssetKind,
  options: { skipCollectionStart?: boolean } = {},
): Promise<Response> {
  try {
    return await uploadMediaAssetInternal(request, env, userId, kind, !options.skipCollectionStart);
  } catch (error) {
    if (error instanceof MediaAssetApiError) return mediaErrorResponse(error);
    throw error;
  }
}

function contentDisposition(filename: string): string {
  const safeAscii = filename.replace(/[\r\n"]/gu, "_").replace(/[^\x20-\x7E]/gu, "_") || "download";
  return `attachment; filename="${safeAscii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function downloadMediaAssetInternal(
  request: Request,
  env: MediaAssetsEnv,
  userId: string,
  kind: MediaAssetKind,
  schoolKey: string,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  const normalizedUserId = normalizeUserId(userId);
  const normalizedKind = requireKind(kind);
  const normalizedSchoolKey = normalizeSchoolKey(schoolKey);
  await ensureMediaAssetsSchema(env.DB);
  const r2Key = await currentR2Key(normalizedUserId, normalizedKind, normalizedSchoolKey);
  const [indexedRow, object] = await Promise.all([
    getMediaRow(env.DB, normalizedUserId, normalizedKind, normalizedSchoolKey),
    env.FILES.get(r2Key),
  ]);
  if (!indexedRow && !object) {
    throw new MediaAssetApiError(
      404,
      "media_asset_not_found",
      normalizedKind === "poster" ? "未找到该学校的海报。" : "未找到该学校的视频。",
    );
  }
  if (!object) {
    throw new MediaAssetApiError(404, "stored_file_not_found", "文件索引存在，但云存储中的文件未找到。");
  }

  const storedRow = mediaRowFromR2(object as R2HeadLike, r2Key, normalizedSchoolKey, normalizedKind);
  if (!storedRow) {
    throw new MediaAssetApiError(
      409,
      "stored_metadata_invalid",
      "云文件的版本信息不完整，请重新提交当前版本以自动修复。",
    );
  }

  if (indexedRow && compareVersion(storedRow.submitted_at, storedRow.submission_id, indexedRow) < 0) {
    throw new MediaAssetApiError(
      409,
      "stored_file_version_behind",
      "云文件版本落后于共享索引，请重新提交索引中的当前最新版本。",
    );
  }

  if (!indexedRow || compareVersion(storedRow.submitted_at, storedRow.submission_id, indexedRow) > 0) {
    // R2 is authoritative during the short R2-first/D1-second write window.
    // This also repairs a previous D1 failure without rewriting the object.
    await persistMediaRow(env.DB, normalizedUserId, storedRow);
  }
  const repairedRow = await getMediaRow(env.DB, normalizedUserId, normalizedKind, normalizedSchoolKey);
  if (repairedRow && compareVersion(repairedRow.submitted_at, repairedRow.submission_id, storedRow) > 0) {
    throw new MediaAssetApiError(
      409,
      "stored_file_version_behind",
      "云文件版本落后于共享索引，请重新提交索引中的当前最新版本。",
    );
  }
  const row = storedRow;
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", row.content_type);
  headers.set("Content-Disposition", contentDisposition(row.filename));
  headers.set("Content-Length", String(object.size));
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("ETag", object.httpEtag);
  return new Response(object.body, { headers });
}

export async function downloadMediaAsset(
  request: Request,
  env: MediaAssetsEnv,
  userId: string,
  kind: MediaAssetKind,
  schoolKey: string,
): Promise<Response> {
  try {
    return await downloadMediaAssetInternal(request, env, userId, kind, schoolKey);
  } catch (error) {
    if (error instanceof MediaAssetApiError) return mediaErrorResponse(error);
    throw error;
  }
}

export async function deleteMediaAsset(
  request: Request,
  env: MediaAssetsEnv,
  userId: string,
  kind: MediaAssetKind,
  schoolKeyValue: string,
): Promise<Response> {
  try {
    if (request.method !== "DELETE") return methodNotAllowed(["DELETE"]);
    const normalizedUserId = normalizeUserId(userId);
    const normalizedKind = requireKind(kind);
    const schoolKey = normalizeSchoolKey(schoolKeyValue);
    await ensureMediaAssetsSchema(env.DB);
    const body = await readSmallJson(request);
    const expectedSubmittedAt = normalizeSubmittedAt(typeof body.submittedAt === "string" ? body.submittedAt : null);
    const expectedSubmissionId = normalizeSubmissionId(typeof body.submissionId === "string" ? body.submissionId : null);
    const current = await getMediaRow(env.DB, normalizedUserId, normalizedKind, schoolKey);
    if (!current) {
      throw new MediaAssetApiError(404, "media_asset_not_found", normalizedKind === "poster" ? "未找到该学校的海报。" : "未找到该学校的视频。");
    }
    if (current.submitted_at !== expectedSubmittedAt || current.submission_id !== expectedSubmissionId) {
      throw new MediaAssetApiError(409, "media_asset_changed", "删除前文件已被更新；请刷新清单并重新确认。" );
    }
    const deletion = await env.DB.prepare(`DELETE FROM shared_media_assets
      WHERE user_id = ? AND kind = ? AND school_key = ? AND submitted_at = ? AND submission_id = ?`)
      .bind(normalizedUserId, normalizedKind, schoolKey, expectedSubmittedAt, expectedSubmissionId).run() as { meta?: { changes?: number } };
    if ((deletion.meta?.changes ?? 0) !== 1) {
      throw new MediaAssetApiError(409, "media_asset_changed", "删除前文件已被更新；请刷新清单并重新确认。" );
    }
    await env.FILES.delete(current.r2_key).catch((error) => {
      console.error("Deleted media index but could not remove orphaned R2 object", error);
    });
    return mediaJson({ ok: true, deleted: true, kind: normalizedKind, schoolKey });
  } catch (error) {
    if (error instanceof MediaAssetApiError) return mediaErrorResponse(error);
    throw error;
  }
}
