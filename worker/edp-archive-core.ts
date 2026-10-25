import JSZip from "jszip";

export type EdpArchiveFormat = "zip" | "7z" | "rar";

export type EdpArchiveErrorCode =
  | "unsupported_archive_format"
  | "archive_signature_mismatch"
  | "invalid_archive"
  | "encrypted_archive"
  | "unsafe_archive_path"
  | "archive_too_large"
  | "archive_entry_unreadable";

export interface EdpArchiveEntry {
  originalPath: string;
  normalizedPath: string;
  displayPath: string;
  displayNameStatus: "reliable" | "recovered" | "uncertain";
  isDirectory: boolean;
  declaredSize: number | null;
  bytes: Uint8Array | null;
}

export interface OpenedEdpArchive {
  format: EdpArchiveFormat;
  entries: EdpArchiveEntry[];
}

export interface LibarchiveEntryPayload {
  pathname: string;
  size: number | null;
  isDirectory: boolean;
  bytes: Uint8Array | null;
  displayNameStatus?: EdpArchiveEntry["displayNameStatus"];
}

export interface EdpArchiveDependencies {
  readLibarchiveEntries(bytes: Uint8Array): Promise<LibarchiveEntryPayload[]>;
}

export const EDP_ARCHIVE_LIMITS = Object.freeze({
  entries: 100,
  depth: 12,
  singleFileBytes: 30 * 1024 * 1024,
  totalFileBytes: 80 * 1024 * 1024,
});

export class EdpArchiveError extends Error {
  constructor(readonly code: EdpArchiveErrorCode, message: string) {
    super(message);
    this.name = "EdpArchiveError";
  }
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

function formatFromExtension(filename: string): EdpArchiveFormat | null {
  const extension = filename.trim().toLocaleLowerCase("en-US").match(/\.([^.]+)$/u)?.[1];
  if (extension === "zip" || extension === "7z" || extension === "rar") return extension;
  return null;
}

export function sniffEdpArchiveFormat(bytes: Uint8Array, filename: string): EdpArchiveFormat {
  let detected: EdpArchiveFormat | null = null;
  if (
    startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])
    || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])
    || startsWith(bytes, [0x50, 0x4b, 0x07, 0x08])
  ) detected = "zip";
  else if (startsWith(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) detected = "7z";
  else if (
    startsWith(bytes, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00])
    || startsWith(bytes, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00])
  ) detected = "rar";

  const extension = formatFromExtension(filename);
  if (!detected) {
    throw new EdpArchiveError(
      extension ? "archive_signature_mismatch" : "unsupported_archive_format",
      extension ? `文件内容不是有效的 ${extension.toUpperCase()} 压缩包。` : "仅支持 ZIP、7z 或 RAR 压缩包。",
    );
  }
  if (!extension || extension !== detected) {
    throw new EdpArchiveError("archive_signature_mismatch", `文件扩展名与实际 ${detected.toUpperCase()} 格式不一致。`);
  }
  return detected;
}

function mapArchiveFailure(error: unknown): EdpArchiveError {
  if (error instanceof EdpArchiveError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/encrypt|password|passphrase|密码|加密/iu.test(message)) {
    return new EdpArchiveError("encrypted_archive", "压缩包已加密或需要密码，无法安全读取。");
  }
  return new EdpArchiveError("invalid_archive", `压缩包损坏或无法读取：${message || "未知错误"}`);
}

function normalizeArchivePath(pathname: string): string {
  if (!pathname || pathname.includes("\0")) {
    throw new EdpArchiveError("unsafe_archive_path", "压缩包包含空名称或非法空字符路径。");
  }
  const slashPath = pathname.replaceAll("\\", "/");
  if (slashPath.startsWith("/") || slashPath.startsWith("//") || /^[A-Za-z]:\//u.test(slashPath)) {
    throw new EdpArchiveError("unsafe_archive_path", `压缩包包含绝对路径：${pathname}`);
  }
  const rawSegments = slashPath.split("/");
  if (rawSegments.some((segment) => segment === "..")) {
    throw new EdpArchiveError("unsafe_archive_path", `压缩包包含目录穿越路径：${pathname}`);
  }
  const segments = rawSegments.filter((segment) => segment && segment !== ".");
  if (segments.length > EDP_ARCHIVE_LIMITS.depth) {
    throw new EdpArchiveError("unsafe_archive_path", `压缩包目录层级超过 ${EDP_ARCHIVE_LIMITS.depth} 层：${pathname}`);
  }
  if (segments.length === 0) {
    throw new EdpArchiveError("unsafe_archive_path", `压缩包包含无效路径：${pathname}`);
  }
  return segments.join("/");
}

function validateEntries(format: EdpArchiveFormat, entries: EdpArchiveEntry[]): OpenedEdpArchive {
  if (entries.length > EDP_ARCHIVE_LIMITS.entries) {
    throw new EdpArchiveError("archive_too_large", `压缩包条目超过 ${EDP_ARCHIVE_LIMITS.entries} 个。`);
  }
  let total = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (entry.declaredSize === null || !Number.isSafeInteger(entry.declaredSize) || entry.declaredSize < 0) {
      throw new EdpArchiveError("archive_entry_unreadable", `无法确认文件解压大小：${entry.displayPath}`);
    }
    if (entry.declaredSize > EDP_ARCHIVE_LIMITS.singleFileBytes) {
      throw new EdpArchiveError("archive_too_large", `单个文件解压后超过 30MB：${entry.displayPath}`);
    }
    if (!entry.bytes || entry.bytes.byteLength !== entry.declaredSize) {
      throw new EdpArchiveError("archive_entry_unreadable", `文件未能完整读取：${entry.displayPath}`);
    }
    total += entry.declaredSize;
    if (total > EDP_ARCHIVE_LIMITS.totalFileBytes) {
      throw new EdpArchiveError("archive_too_large", "压缩包解压后的文件总量超过 80MB。");
    }
  }
  return { format, entries };
}

function zipNameDecoder(statusByName: Map<string, EdpArchiveEntry["displayNameStatus"]>) {
  return (input: Uint8Array | string[]): string => {
    const bytes = Array.isArray(input) ? Uint8Array.from(input, value => value.charCodeAt(0)) : input;
    try {
      const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      statusByName.set(value, "reliable");
      return value;
    } catch {
      try {
        const value = new TextDecoder("gb18030", { fatal: true }).decode(bytes);
        const status = value.includes("�") ? "uncertain" : "recovered";
        statusByName.set(value, status);
        return value;
      } catch {
        const value = new TextDecoder().decode(bytes);
        statusByName.set(value, "uncertain");
        return value;
      }
    }
  };
}

async function readZipEntries(bytes: Uint8Array): Promise<EdpArchiveEntry[]> {
  const statusByName = new Map<string, EdpArchiveEntry["displayNameStatus"]>();
  const zip = await JSZip.loadAsync(bytes, { decodeFileName: zipNameDecoder(statusByName), createFolders: true });
  const objects = Object.values(zip.files);
  if (objects.length > EDP_ARCHIVE_LIMITS.entries) {
    throw new EdpArchiveError("archive_too_large", `压缩包条目超过 ${EDP_ARCHIVE_LIMITS.entries} 个。`);
  }
  const result: EdpArchiveEntry[] = [];
  for (const object of objects) {
    const internal = object as typeof object & {
      unsafeOriginalName?: string;
      _data?: { uncompressedSize?: number };
    };
    const originalPath = internal.unsafeOriginalName || object.name;
    const normalizedPath = normalizeArchivePath(originalPath);
    const isDirectory = object.dir;
    const declaredSize = isDirectory ? 0 : Number(internal._data?.uncompressedSize);
    if (!isDirectory && (!Number.isSafeInteger(declaredSize) || declaredSize < 0)) {
      throw new EdpArchiveError("archive_entry_unreadable", `无法确认文件解压大小：${normalizedPath}`);
    }
    if (!isDirectory && declaredSize > EDP_ARCHIVE_LIMITS.singleFileBytes) {
      throw new EdpArchiveError("archive_too_large", `单个文件解压后超过 30MB：${normalizedPath}`);
    }
    const entryBytes = isDirectory ? null : await object.async("uint8array");
    const displayNameStatus = statusByName.get(object.name)
      || (object.name.includes("�") ? "uncertain" : "reliable");
    result.push({
      originalPath,
      normalizedPath,
      displayPath: normalizedPath,
      displayNameStatus,
      isDirectory,
      declaredSize,
      bytes: entryBytes,
    });
  }
  return result;
}

export async function openEdpArchiveCore(
  bytes: Uint8Array,
  filename: string,
  dependencies: EdpArchiveDependencies,
): Promise<OpenedEdpArchive> {
  const format = sniffEdpArchiveFormat(bytes, filename);
  try {
    if (format === "zip") return validateEntries(format, await readZipEntries(bytes));
    const payloads = await dependencies.readLibarchiveEntries(bytes);
    const entries = payloads.map((payload) => {
      const normalizedPath = normalizeArchivePath(payload.pathname);
      return {
        originalPath: payload.pathname,
        normalizedPath,
        displayPath: normalizedPath,
        displayNameStatus: payload.displayNameStatus
          || (payload.pathname.includes("�") ? "uncertain" : "reliable"),
        isDirectory: payload.isDirectory,
        declaredSize: payload.isDirectory ? 0 : payload.size,
        bytes: payload.isDirectory ? null : payload.bytes,
      } satisfies EdpArchiveEntry;
    });
    return validateEntries(format, entries);
  } catch (error) {
    throw mapArchiveFailure(error);
  }
}
