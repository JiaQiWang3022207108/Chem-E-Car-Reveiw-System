export interface CertificateTemplateApiEnv {
  DB: D1Database;
  FILES: R2Bucket;
  IMAGES?: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

export interface CertificateTemplatePayload {
  eventName: string;
  issuerText: string;
  stamp: {
    configured: boolean;
    filename: string | null;
    contentType: "image/png" | "image/jpeg" | null;
    url: string | null;
  };
  complete: boolean;
  updatedAt: string | null;
}

export interface CertificateTemplateResponse {
  ok: true;
  competitionYear: string;
  template: CertificateTemplatePayload;
}

const MAX_STAMP_BYTES = 5 * 1024 * 1024;
const MIN_STAMP_EDGE = 300;
const MAX_STAMP_PIXELS = 16_000_000;
const MAX_EVENT_NAME_LENGTH = 200;
const MAX_ISSUER_TEXT_LENGTH = 600;

type StampContentType = "image/png" | "image/jpeg";

interface CertificateTemplateRow {
  event_name: string;
  issuer_text: string;
  stamp_r2_key: string | null;
  stamp_filename: string | null;
  stamp_content_type: string | null;
  stamp_size: number | null;
  updated_at: string;
}

class CertificateTemplateApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CertificateTemplateApiError";
  }
}

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  responseHeaders.set("Cache-Control", "no-store");
  responseHeaders.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(data), { status, headers: responseHeaders });
}

function methodNotAllowed(allowed: string[]): Response {
  return json({
    ok: false,
    error: { code: "method_not_allowed", message: `此接口仅支持 ${allowed.join("、")} 请求。` },
  }, 405, { Allow: allowed.join(", ") });
}

function errorResponse(error: unknown): Response {
  if (error instanceof CertificateTemplateApiError) {
    return json({ ok: false, error: { code: error.code, message: error.message } }, error.status);
  }
  console.error("Certificate template API failed");
  return json({
    ok: false,
    error: { code: "certificate_template_api_failed", message: "证书模板暂时无法处理，请稍后重试。" },
  }, 500);
}

function stampKey(userId: string, contentType: StampContentType): string {
  const extension = contentType === "image/png" ? "png" : "jpg";
  const storageUser = userId.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 64);
  return `users/${storageUser}/certificate-template/stamp-${crypto.randomUUID()}.${extension}`;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
}

function pngCrc(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc ^= bytes[index];
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function imageDimensions(contentType: StampContentType, bytes: Uint8Array): { width: number; height: number } {
  if (contentType === "image/png") return pngDimensions(bytes);
  return jpegDimensions(bytes);
}

async function verifyStampDecode(env: CertificateTemplateApiEnv, bytes: Uint8Array, width: number, height: number): Promise<void> {
  if (width * height > MAX_STAMP_PIXELS || width > 8000 || height > 8000) {
    throw new CertificateTemplateApiError(422, "stamp_dimensions_too_large", "公章图片不能超过 1600 万像素，宽高均不得超过 8000 像素。");
  }
  if (!env.IMAGES) {
    throw new CertificateTemplateApiError(503, "stamp_decoder_unavailable", "服务器公章图片解码服务不可用，请联系管理员检查 IMAGES 配置。原公章保持不变。");
  }
  try {
    // Reuse the site's existing image service. Header parsing is NOT image decoding.
    // A bounded thumbnail forces full input decoding; drain the response so delayed
    // decoder/stream errors happen before either R2 or D1 is mutated.
    const input = new Uint8Array(bytes.byteLength);
    input.set(bytes);
    const result = await env.IMAGES.input(new Blob([input.buffer]).stream())
      .transform({ width: 300, height: 300, fit: "scale-down" }).output({ format: "image/png", quality: 100 });
    const response = result.response();
    if (!response.ok || !response.body) throw new Error("image decode response failed");
    const reader = response.body.getReader();
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_STAMP_BYTES) {
          await reader.cancel();
          throw new Error("image decode output exceeds limit");
        }
      }
    } finally { reader.releaseLock(); }
    if (!total) throw new Error("empty decoded output");
  } catch {
    throw new CertificateTemplateApiError(415, "invalid_stamp_image", "公章图片无法完整解码，请重新导出有效的 PNG 或 JPEG 图片。原公章保持不变。");
  }
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.byteLength < signature.length || !signature.every((value, index) => bytes[index] === value)) {
    throw new CertificateTemplateApiError(415, "invalid_stamp_image", "公章必须是有效的 PNG 或 JPEG 图片。");
  }
  let offset = signature.length;
  let width = 0;
  let height = 0;
  let sawIhdr = false;
  let sawIdat = false;
  let sawIend = false;
  while (offset < bytes.byteLength) {
    if (offset + 12 > bytes.byteLength) {
      throw new CertificateTemplateApiError(415, "invalid_stamp_image", "PNG 图片结构不完整。");
    }
    const length = readUint32(bytes, offset);
    const chunkEnd = offset + 12 + length;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > bytes.byteLength) {
      throw new CertificateTemplateApiError(415, "invalid_stamp_image", "PNG 图片结构不完整。");
    }
    if (pngCrc(bytes, offset + 4, chunkEnd - 4) !== readUint32(bytes, chunkEnd - 4)) {
      throw new CertificateTemplateApiError(415, "invalid_stamp_image", "PNG 图片校验失败，数据可能已损坏。");
    }
    const chunkType = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const payloadOffset = offset + 8;
    if (!sawIhdr && chunkType !== "IHDR") {
      throw new CertificateTemplateApiError(415, "invalid_stamp_image", "PNG 图片缺少 IHDR 信息。");
    }
    if (chunkType === "IHDR") {
      if (sawIhdr || length !== 13) {
        throw new CertificateTemplateApiError(415, "invalid_stamp_image", "PNG 图片 IHDR 信息无效。");
      }
      width = readUint32(bytes, payloadOffset);
      height = readUint32(bytes, payloadOffset + 4);
      if (width === 0 || height === 0) {
        throw new CertificateTemplateApiError(415, "invalid_stamp_image", "PNG 图片尺寸无效。");
      }
      sawIhdr = true;
    } else if (chunkType === "IDAT") {
      if (!sawIhdr || sawIend) {
        throw new CertificateTemplateApiError(415, "invalid_stamp_image", "PNG 图片数据块顺序无效。");
      }
      sawIdat = true;
    } else if (chunkType === "IEND") {
      if (!sawIhdr || !sawIdat || length !== 0 || chunkEnd !== bytes.byteLength) {
        throw new CertificateTemplateApiError(415, "invalid_stamp_image", "PNG 图片结束标记无效。");
      }
      sawIend = true;
      break;
    }
    offset = chunkEnd;
  }
  if (!sawIhdr || !sawIdat || !sawIend) {
    throw new CertificateTemplateApiError(415, "invalid_stamp_image", "PNG 图片结构不完整。");
  }
  return { width, height };
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.byteLength - 2] !== 0xff || bytes[bytes.byteLength - 1] !== 0xd9) {
    throw new CertificateTemplateApiError(415, "invalid_stamp_image", "公章必须是有效的 PNG 或 JPEG 图片。");
  }
  let offset = 2;
  let dimensions: { width: number; height: number } | null = null;
  let sawQuantization = false;
  let sawHuffman = false;
  let sawScan = false;
  while (offset + 1 < bytes.byteLength - 2) {
    if (bytes[offset] !== 0xff) {
      throw new CertificateTemplateApiError(415, "invalid_stamp_image", "JPEG 图片结构无效。");
    }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0x00 || marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      throw new CertificateTemplateApiError(415, "invalid_stamp_image", "JPEG 图片标记顺序无效。");
    }
    if (offset + 2 > bytes.byteLength - 2) {
      throw new CertificateTemplateApiError(415, "invalid_stamp_image", "JPEG 图片结构不完整。");
    }
    const length = (bytes[offset] << 8) + bytes[offset + 1];
    const segmentEnd = offset + length;
    if (length < 2 || segmentEnd > bytes.byteLength - 2) {
      throw new CertificateTemplateApiError(415, "invalid_stamp_image", "JPEG 图片结构不完整。");
    }
    const isSof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      const components = bytes[offset + 7];
      if (dimensions || length < 11 || components < 1 || components > 4 || length !== 8 + 3 * components) {
        throw new CertificateTemplateApiError(415, "invalid_stamp_image", "JPEG 图片尺寸信息无效。");
      }
      const height = (bytes[offset + 3] << 8) + bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) + bytes[offset + 6];
      if (width === 0 || height === 0) throw new CertificateTemplateApiError(415, "invalid_stamp_image", "JPEG 图片尺寸无效。");
      dimensions = { width, height };
    }
    if (marker === 0xdb) sawQuantization = true;
    if (marker === 0xc4) sawHuffman = true;
    offset = segmentEnd;
    if (marker === 0xda) {
      const componentCount = bytes[segmentEnd - length + 2];
      if (!dimensions || !sawQuantization || !sawHuffman || componentCount < 1 || componentCount > 4 || length !== 6 + 2 * componentCount) {
        throw new CertificateTemplateApiError(415, "invalid_stamp_image", "JPEG 图片扫描信息不完整。");
      }
      const scanStart = offset;
      // Walk all entropy bytes/escaped FFs and restart markers, not just the SOF.
      while (offset < bytes.length - 2) {
        if (bytes[offset] !== 0xff) { offset += 1; continue; }
        const next = bytes[offset + 1];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) { offset += 2; continue; }
        break;
      }
      if (offset === scanStart) throw new CertificateTemplateApiError(415, "invalid_stamp_image", "JPEG 图片扫描数据缺失。");
      sawScan = true;
    }
  }
  if (dimensions && sawScan && offset === bytes.length - 2) return dimensions;
  throw new CertificateTemplateApiError(415, "invalid_stamp_image", "JPEG 图片缺少尺寸信息。");
}

function payloadFromRow(row: CertificateTemplateRow | null): CertificateTemplatePayload {
  const contentType = row?.stamp_content_type === "image/png" || row?.stamp_content_type === "image/jpeg"
    ? row.stamp_content_type
    : null;
  const configured = Boolean(row?.stamp_r2_key && contentType);
  const eventName = row?.event_name ?? "";
  const issuerText = row?.issuer_text ?? "";
  return {
    eventName,
    issuerText,
    stamp: {
      configured,
      filename: configured ? row?.stamp_filename ?? null : null,
      contentType: configured ? contentType : null,
      url: configured ? "/api/certificate-template/stamp" : null,
    },
    complete: Boolean(eventName.trim() && issuerText.trim() && configured),
    updatedAt: row?.updated_at ?? null,
  };
}

async function getTemplate(request: Request, env: CertificateTemplateApiEnv, userId: string): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(["GET", "PUT"]);
  const [template, settings] = await Promise.all([
    env.DB.prepare(`SELECT event_name, issuer_text, stamp_r2_key, stamp_filename,
      stamp_content_type, stamp_size, updated_at FROM certificate_templates WHERE user_id = ?`)
      .bind(userId).first<CertificateTemplateRow>(),
    env.DB.prepare("SELECT competition_year FROM edp_review_settings WHERE user_id = ?")
      .bind(userId).first<{ competition_year: string }>(),
  ]);
  const response: CertificateTemplateResponse = {
    ok: true,
    competitionYear: settings?.competition_year ?? "",
    template: payloadFromRow(template),
  };
  return json(response);
}

function requiredText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string") {
    throw new CertificateTemplateApiError(400, "invalid_template", `${field} 必须是文本。`);
  }
  if (value.length > maximum) {
    throw new CertificateTemplateApiError(400, "invalid_template", `${field} 不能超过 ${maximum} 个字符。`);
  }
  return value;
}

async function saveTemplate(request: Request, env: CertificateTemplateApiEnv, userId: string): Promise<Response> {
  if (request.method !== "PUT") return methodNotAllowed(["GET", "PUT"]);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new CertificateTemplateApiError(400, "invalid_template", "证书模板内容必须是 JSON。");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new CertificateTemplateApiError(400, "invalid_template", "证书模板内容必须是对象。");
  }
  const input = body as Record<string, unknown>;
  const eventName = requiredText(input.eventName, "赛事名称", MAX_EVENT_NAME_LENGTH);
  const issuerText = requiredText(input.issuerText, "落款", MAX_ISSUER_TEXT_LENGTH);
  const updatedAt = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO certificate_templates (user_id, event_name, issuer_text, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET event_name = excluded.event_name,
      issuer_text = excluded.issuer_text, updated_at = excluded.updated_at`)
    .bind(userId, eventName, issuerText, updatedAt).run();
  const template = await env.DB.prepare(`SELECT event_name, issuer_text, stamp_r2_key, stamp_filename,
    stamp_content_type, stamp_size, updated_at FROM certificate_templates WHERE user_id = ?`)
    .bind(userId).first<CertificateTemplateRow>();
  return json({ ok: true, template: payloadFromRow(template) });
}

function acceptedContentType(file: File): StampContentType {
  if (file.type === "image/png" || file.type === "image/jpeg") return file.type;
  throw new CertificateTemplateApiError(415, "unsupported_stamp_type", "公章仅支持 PNG 或 JPEG 图片。");
}

async function uploadStamp(request: Request, env: CertificateTemplateApiEnv, userId: string): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["GET", "POST"]);
  const formData = await request.formData();
  const stamp = formData.get("stamp");
  if (!(stamp instanceof File)) {
    throw new CertificateTemplateApiError(400, "stamp_required", "请选择需要上传的公章图片。");
  }
  const contentType = acceptedContentType(stamp);
  if (stamp.size === 0 || stamp.size > MAX_STAMP_BYTES) {
    throw new CertificateTemplateApiError(413, "stamp_too_large", "公章图片必须小于或等于 5 MB。");
  }
  const bytes = new Uint8Array(await stamp.arrayBuffer());
  const { width, height } = imageDimensions(contentType, bytes);
  if (width < MIN_STAMP_EDGE || height < MIN_STAMP_EDGE) {
    throw new CertificateTemplateApiError(422, "stamp_dimensions_too_small", "公章图片宽高均不得小于 300 像素。");
  }
  await verifyStampDecode(env, bytes, width, height);
  const key = stampKey(userId, contentType);
  const filename = stamp.name.slice(0, 255) || `official-stamp.${contentType === "image/png" ? "png" : "jpg"}`;
  const previous = await env.DB.prepare("SELECT stamp_r2_key FROM certificate_templates WHERE user_id = ?")
    .bind(userId).first<{ stamp_r2_key: string | null }>();
  await env.FILES.put(key, bytes, { httpMetadata: { contentType } });
  const updatedAt = new Date().toISOString();
  try {
    await env.DB.prepare(`INSERT INTO certificate_templates
      (user_id, stamp_r2_key, stamp_filename, stamp_content_type, stamp_size, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET stamp_r2_key = excluded.stamp_r2_key,
        stamp_filename = excluded.stamp_filename, stamp_content_type = excluded.stamp_content_type,
        stamp_size = excluded.stamp_size, updated_at = excluded.updated_at`)
      .bind(userId, key, filename, contentType, bytes.byteLength, updatedAt).run();
  } catch (error) {
    await env.FILES.delete(key);
    throw error;
  }
  if (previous?.stamp_r2_key && previous.stamp_r2_key !== key) {
    try { await env.FILES.delete(previous.stamp_r2_key); }
    catch { console.warn("Certificate obsolete stamp cleanup failed after commit"); }
  }
  const template = await env.DB.prepare(`SELECT event_name, issuer_text, stamp_r2_key, stamp_filename,
    stamp_content_type, stamp_size, updated_at FROM certificate_templates WHERE user_id = ?`)
    .bind(userId).first<CertificateTemplateRow>();
  return json({ ok: true, template: payloadFromRow(template) });
}

async function downloadStamp(request: Request, env: CertificateTemplateApiEnv, userId: string): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  const row = await env.DB.prepare(`SELECT stamp_r2_key, stamp_content_type FROM certificate_templates WHERE user_id = ?`)
    .bind(userId).first<{ stamp_r2_key: string | null; stamp_content_type: string | null }>();
  const contentType = row?.stamp_content_type === "image/png" || row?.stamp_content_type === "image/jpeg"
    ? row.stamp_content_type
    : null;
  if (!row?.stamp_r2_key || !contentType) {
    throw new CertificateTemplateApiError(404, "stamp_not_configured", "尚未上传证书公章。");
  }
  const object = await env.FILES.get(row.stamp_r2_key);
  if (!object) throw new CertificateTemplateApiError(404, "stamp_missing", "公章记录存在，但图片已丢失。");
  const headers = new Headers();
  headers.set("Content-Type", contentType);
  headers.set("Content-Length", String(object.size));
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(object.body, { headers });
}

export async function handleCertificateTemplateApi(
  request: Request,
  env: CertificateTemplateApiEnv,
  userId: string,
  url: URL,
): Promise<Response | null> {
  if (url.pathname !== "/api/certificate-template" && url.pathname !== "/api/certificate-template/stamp") return null;
  try {
    if (url.pathname === "/api/certificate-template") {
      return request.method === "PUT" ? await saveTemplate(request, env, userId) : await getTemplate(request, env, userId);
    }
    return request.method === "POST" ? await uploadStamp(request, env, userId) : await downloadStamp(request, env, userId);
  } catch (error) {
    return errorResponse(error);
  }
}
