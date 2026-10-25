import type {SevenZipModule, SevenZipModuleFactory} from "7z-wasm";
import {EDP_ARCHIVE_LIMITS, EdpArchiveError, type LibarchiveEntryPayload} from "./edp-archive-core";

// 7-Zip's own Unicode reader avoids libarchive-wasm 1.2 replacing Chinese
// names with '*'. All writes stay in a fresh in-memory filesystem per request.
export async function readSevenZipEntries(bytes: Uint8Array, factory: SevenZipModuleFactory): Promise<LibarchiveEntryPayload[]> {
  let output: string[] = [];
  let outputLength = 0;
  const append = (line: string) => {
    outputLength += line.length;
    if (outputLength > 128_000) throw new EdpArchiveError("archive_too_large", "压缩包目录信息过大。");
    output.push(line);
  };
  const seven = await factory({print: append, printErr: append, stdin: () => -1});
  const fs = seven.FS;
  // canOwn is supported by Emscripten but omitted from 7z-wasm 1.2 typings.
  const writeOptions: Parameters<typeof fs.writeFile>[2] & {canOwn: boolean} = {canOwn: true};
  fs.writeFile("/input", bytes, writeOptions);
  const run = (args: string[]) => {
    output = []; outputLength = 0;
    const exit = seven.callMain([...args, "-bd", "-bsp0", "-sccUTF-8", "-p-", "/input"]) as unknown as number;
    if (exit !== 0 && exit !== undefined) {
      const message = output.join("\n");
      if (/password|encrypted|Wrong password/iu.test(message)) throw new EdpArchiveError("encrypted_archive", "压缩包已加密或需要密码。");
      throw new EdpArchiveError("invalid_archive", "压缩包读取失败：" + message.slice(-300));
    }
  };
  try {
    run(["l", "-slt", "-ba"]);
    const manifest = parseSevenZipListing(output.join("\n"));
    fs.mkdir("/output");
    // Listing is checked BEFORE extraction. Also enforce actual write sizes,
    // since a malicious archive can lie about its uncompressed size.
    const originalWrite = fs.write.bind(fs);
    const lengths = new Map<string, number>();
    let total = 0;
    fs.write = ((stream, buffer, offset, length, position, ...rest) => {
      // Runtime FSStream fields are not exposed in the package declaration.
      const runtimeStream = stream as typeof stream & {fd: number; position: number; node: Parameters<typeof fs.getPath>[0]};
      if (runtimeStream.fd === 1 || runtimeStream.fd === 2) return originalWrite(stream, buffer, offset, length, position, ...rest);
      const pathname = fs.getPath(runtimeStream.node);
      if (!pathname.startsWith("/output/")) throw new EdpArchiveError("unsafe_archive_path", "解压目标路径不安全。");
      const next = Math.max(lengths.get(pathname) || 0, (position ?? runtimeStream.position) + length);
      total += next - (lengths.get(pathname) || 0); lengths.set(pathname, next);
      if (next > EDP_ARCHIVE_LIMITS.singleFileBytes || total > EDP_ARCHIVE_LIMITS.totalFileBytes) throw new EdpArchiveError("archive_too_large", "解压后的文件超过安全大小限制。");
      return originalWrite(stream, buffer, offset, length, position, ...rest);
    }) as SevenZipModule["FS"]["write"];
    run(["x", "-y", "-o/output"]);
    const result: LibarchiveEntryPayload[] = [];
    for (const entry of manifest) {
      const pathname = "/output/" + entry.pathname;
      const stat = fs.lstat(pathname);
      if (entry.isDirectory ? !fs.isDir(stat.mode) : !fs.isFile(stat.mode)) throw new EdpArchiveError("unsafe_archive_path", "压缩包包含符号链接或特殊文件。");
      if (!entry.isDirectory && stat.size !== entry.size) throw new EdpArchiveError("archive_entry_unreadable", "解压文件大小与目录不一致。");
      result.push({...entry, bytes: entry.isDirectory ? null : fs.readFile(pathname)});
      if (!entry.isDirectory) fs.unlink(pathname); // release the MEMFS copy immediately
    }
    return result;
  } finally {
    fs.unlink("/input");
    // No persistent module cache: the decoder heap and MEMFS can be collected.
  }
}

export function parseSevenZipListing(text: string): LibarchiveEntryPayload[] {
  const records = text.trim().split(/\r?\n\s*\r?\n/u).filter(Boolean);
  if (records.length > EDP_ARCHIVE_LIMITS.entries) throw new EdpArchiveError("archive_too_large", "压缩包条目超过 100 个。");
  let total = 0;
  const seen = new Set<string>();
  return records.map(record => {
    const fields = new Map<string, string>();
    for (const line of record.split(/\r?\n/u)) {
      const at = line.indexOf(" = ");
      if (at < 1 || fields.has(line.slice(0, at))) throw new EdpArchiveError("unsafe_archive_path", "压缩包目录包含无法安全读取的文件名。");
      fields.set(line.slice(0, at), line.slice(at + 3));
    }
    const pathname = (fields.get("Path") || "").replaceAll("\\", "/").replace(/\/$/u, "");
    const parts = pathname.split("/");
    if (!pathname || [...pathname].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || pathname.startsWith("/") || /^[A-Za-z]:/u.test(pathname) || parts.some(p => !p || p === "." || p === "..") || parts.length > EDP_ARCHIVE_LIMITS.depth || seen.has(pathname)) {
      throw new EdpArchiveError("unsafe_archive_path", "压缩包包含不安全或重复的路径。");
    }
    seen.add(pathname);
    if (fields.get("Encrypted") === "+") throw new EdpArchiveError("encrypted_archive", "压缩包已加密或需要密码。");
    const attributes = fields.get("Attributes") || "";
    if (fields.get("Symbolic Link") || fields.get("Hard Link") || /(?:^|\s)[lbcps][rwx-]{9}/u.test(attributes)) throw new EdpArchiveError("unsafe_archive_path", "压缩包包含链接或特殊文件。");
    const isDirectory = fields.get("Folder") === "+" || /^D|\sd[rwx-]{9}/u.test(attributes);
    const size = isDirectory ? 0 : Number(fields.get("Size"));
    if (!Number.isSafeInteger(size) || size < 0) throw new EdpArchiveError("archive_entry_unreadable", "无法确认文件解压大小。");
    total += size;
    if (size > EDP_ARCHIVE_LIMITS.singleFileBytes || total > EDP_ARCHIVE_LIMITS.totalFileBytes) throw new EdpArchiveError("archive_too_large", "压缩包超过解压安全大小限制。");
    return {pathname, size, isDirectory, bytes: null};
  });
}
