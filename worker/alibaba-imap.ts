/**
 * Minimal, bounded IMAP client for Alibaba Enterprise Mail on Cloudflare Workers.
 *
 * The module deliberately has no logging hooks: an IMAP LOGIN command contains a
 * secret and must never be copied into an exception, trace, or database record.
 */

export const ALIBABA_IMAP_HOST = "imap.qiye.aliyun.com";
export const ALIBABA_IMAP_PORT = 993;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: false });

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
const DEFAULT_OVERALL_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_LINE_BYTES = 64 * 1024;
const ABSOLUTE_MAX_WIRE_BYTES = 128 * 1024 * 1024;

export interface ImapSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
}

export type ImapSocketFactory = (
  hostname: string,
  port: number,
) => ImapSocket | Promise<ImapSocket>;

export interface AlibabaImapOptions {
  host?: string;
  port?: number;
  email: string;
  password: string;
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
  overallTimeoutMs?: number;
  maxWireBytes?: number;
  /** Intended for deterministic unit tests; production callers should omit it. */
  socketFactory?: ImapSocketFactory;
}

export interface MimeAttachment {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface ParsedMailMessage {
  messageId: string | null;
  subject: string;
  fromName: string | null;
  fromAddress: string | null;
  receivedAt: string | null;
  attachments: MimeAttachment[];
}

export interface MimeParseLimits {
  maxHeaderBytes?: number;
  maxParts?: number;
  maxDepth?: number;
  maxAttachments?: number;
  maxAttachmentBytes?: number;
  maxTotalAttachmentBytes?: number;
}

export interface FetchedImapMessage {
  uid: number;
  internalDate: string | null;
  rawBytes: Uint8Array;
}

export interface MailboxSelection {
  uidValidity: string;
  uidNext: number | null;
}

export class AlibabaImapError extends Error {
  readonly code:
    | "CONFIGURATION"
    | "CONNECT_TIMEOUT"
    | "TIMEOUT"
    | "AUTHENTICATION"
    | "PROTOCOL"
    | "MIME"
    | "LIMIT_EXCEEDED"
    | "CONNECTION";

  constructor(code: AlibabaImapError["code"], message: string) {
    super(message);
    this.name = "AlibabaImapError";
    this.code = code;
  }
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new AlibabaImapError("CONFIGURATION", `Invalid ${name}`);
  }
  return result;
}

function validateEndpoint(host: string, port: number): void {
  // Hosts are not interpolated into IMAP commands, but restricting their shape
  // prevents accidental SSRF when this low-level helper is integrated into an API.
  if (host !== ALIBABA_IMAP_HOST) {
    throw new AlibabaImapError(
      "CONFIGURATION",
      `Only ${ALIBABA_IMAP_HOST} is supported`,
    );
  }
  if (port !== ALIBABA_IMAP_PORT) {
    throw new AlibabaImapError(
      "CONFIGURATION",
      `Only TLS port ${ALIBABA_IMAP_PORT} is supported`,
    );
  }
}

function validateCredential(value: string, name: string): void {
  const byteLength = utf8Encoder.encode(value).byteLength;
  if (
    typeof value !== "string" ||
    byteLength < 1 ||
    byteLength > 4096 ||
    /[\r\n\0]/u.test(value)
  ) {
    throw new AlibabaImapError("CONFIGURATION", `Invalid ${name}`);
  }
}

function quoteImapString(value: string): string {
  if (/[\r\n\0]/u.test(value)) {
    throw new AlibabaImapError("CONFIGURATION", "Unsafe IMAP string");
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function deadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  error: AlibabaImapError,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(error), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

async function defaultSocketFactory(
  hostname: string,
  port: number,
): Promise<ImapSocket> {
  // Cloudflare exposes this runtime-only module. Keeping the import lazy also
  // allows MIME helpers to be unit-tested in Node without opening a socket.
  const { connect } = await import("cloudflare:sockets");
  return connect(
    { hostname, port },
    { secureTransport: "on", allowHalfOpen: false },
  ) as ImapSocket;
}

class ImapWire {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private buffer: Uint8Array = new Uint8Array(0);
  private receivedBytes = 0;
  private closed = false;

  constructor(
    private readonly socket: ImapSocket,
    private readonly timeoutMs: number,
    private readonly maxWireBytes: number,
    private readonly maxLineBytes = DEFAULT_MAX_LINE_BYTES,
  ) {
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }

  private async readSocketChunk(): Promise<Uint8Array> {
    const result = await deadline(
      this.reader.read(),
      this.timeoutMs,
      new AlibabaImapError("TIMEOUT", "IMAP server response timed out"),
    );
    if (result.done || !result.value) {
      throw new AlibabaImapError("CONNECTION", "IMAP server closed the connection");
    }
    this.receivedBytes += result.value.byteLength;
    if (this.receivedBytes > this.maxWireBytes) {
      throw new AlibabaImapError("LIMIT_EXCEEDED", "IMAP response limit exceeded");
    }
    return result.value;
  }

  private async readChunk(): Promise<void> {
    const chunk = await this.readSocketChunk();
    if (this.buffer.byteLength === 0) {
      this.buffer = chunk;
      return;
    }
    const merged = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.byteLength);
    this.buffer = merged;
  }

  async readLine(): Promise<string> {
    while (true) {
      for (let index = 0; index < this.buffer.byteLength; index += 1) {
        if (this.buffer[index] !== 0x0a) continue;
        const contentEnd = index > 0 && this.buffer[index - 1] === 0x0d
          ? index - 1
          : index;
        const line = this.buffer.slice(0, contentEnd);
        this.buffer = this.buffer.slice(index + 1);
        return utf8Decoder.decode(line);
      }
      if (this.buffer.byteLength > this.maxLineBytes) {
        throw new AlibabaImapError("LIMIT_EXCEEDED", "IMAP line limit exceeded");
      }
      await this.readChunk();
    }
  }

  async readExactly(length: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new AlibabaImapError("PROTOCOL", "Invalid IMAP literal length");
    }
    if (this.buffer.byteLength >= length) {
      const value = this.buffer.slice(0, length);
      this.buffer = this.buffer.slice(length);
      return value;
    }

    // Literals can be tens of MiB. Appending every socket chunk to `buffer`
    // would repeatedly copy all preceding bytes (quadratic time and a high
    // temporary-memory peak). Allocate the final literal once and fill it as
    // chunks arrive, preserving only a possible trailing IMAP response.
    const value = new Uint8Array(length);
    let offset = this.buffer.byteLength;
    value.set(this.buffer);
    this.buffer = new Uint8Array(0);
    while (offset < length) {
      const chunk = await this.readSocketChunk();
      const take = Math.min(chunk.byteLength, length - offset);
      value.set(chunk.subarray(0, take), offset);
      offset += take;
      if (take < chunk.byteLength) {
        this.buffer = chunk.slice(take);
      }
    }
    return value;
  }

  async sendLine(line: string): Promise<void> {
    if (/[\r\n\0]/u.test(line)) {
      throw new AlibabaImapError("CONFIGURATION", "Unsafe IMAP command");
    }
    await deadline(
      this.writer.write(utf8Encoder.encode(`${line}\r\n`)),
      this.timeoutMs,
      new AlibabaImapError("TIMEOUT", "IMAP command timed out"),
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.reader.cancel();
    } catch {
      // Best-effort cancellation; socket.close below is authoritative.
    }
    try {
      await this.writer.close();
    } catch {
      // The peer may already have closed the TLS connection.
    }
    try {
      this.reader.releaseLock();
      this.writer.releaseLock();
    } catch {
      // Locks can already be released by the runtime.
    }
    try {
      await this.socket.close();
    } catch {
      // Closing is idempotent from the caller's perspective.
    }
  }
}

interface CommandResponse {
  lines: string[];
  status: "OK" | "NO" | "BAD";
}

export class AlibabaImapSession {
  private tagCounter = 0;
  private authenticated = false;
  private protocolHealthy = true;
  private closed = false;

  private constructor(
    private readonly wire: ImapWire,
    private readonly email: string,
    private password: string,
  ) {}

  static async open(options: AlibabaImapOptions): Promise<AlibabaImapSession> {
    const host = options.host ?? ALIBABA_IMAP_HOST;
    const port = options.port ?? ALIBABA_IMAP_PORT;
    validateEndpoint(host, port);
    validateCredential(options.email, "email address");
    validateCredential(options.password, "password");

    const connectTimeoutMs = boundedInteger(
      options.connectTimeoutMs,
      DEFAULT_CONNECT_TIMEOUT_MS,
      1_000,
      30_000,
      "connect timeout",
    );
    const commandTimeoutMs = boundedInteger(
      options.commandTimeoutMs,
      DEFAULT_COMMAND_TIMEOUT_MS,
      1_000,
      60_000,
      "command timeout",
    );
    const maxWireBytes = boundedInteger(
      options.maxWireBytes,
      48 * 1024 * 1024,
      1024,
      ABSOLUTE_MAX_WIRE_BYTES,
      "wire byte limit",
    );

    const socketFactory = options.socketFactory ?? defaultSocketFactory;
    let socket: ImapSocket;
    try {
      socket = await deadline(
        Promise.resolve(socketFactory(host, port)),
        connectTimeoutMs,
        new AlibabaImapError("CONNECT_TIMEOUT", "Alibaba Mail connection timed out"),
      );
    } catch (error) {
      if (error instanceof AlibabaImapError) throw error;
      throw new AlibabaImapError("CONNECTION", "Unable to connect to Alibaba Mail");
    }

    const wire = new ImapWire(socket, commandTimeoutMs, maxWireBytes);
    const session = new AlibabaImapSession(wire, options.email, options.password);
    try {
      const greeting = await wire.readLine();
      if (/^\*\s+PREAUTH\b/iu.test(greeting)) {
        session.authenticated = true;
        session.password = "";
        return session;
      }
      if (!/^\*\s+OK\b/iu.test(greeting)) {
        throw new AlibabaImapError("PROTOCOL", "Alibaba Mail rejected the connection");
      }
      await session.login();
      return session;
    } catch (error) {
      session.password = "";
      await wire.close();
      throw error;
    }
  }

  private nextTag(): string {
    this.tagCounter += 1;
    return `C${String(this.tagCounter).padStart(5, "0")}`;
  }

  private async command(command: string): Promise<CommandResponse> {
    try {
      const tag = this.nextTag();
      await this.wire.sendLine(`${tag} ${command}`);
      const lines: string[] = [];
      while (true) {
        const line = await this.wire.readLine();
        if (/^\*\s+BYE\b/iu.test(line)) {
          this.protocolHealthy = false;
          throw new AlibabaImapError("CONNECTION", "Alibaba Mail closed the session");
        }
        if (line.startsWith(`${tag} `)) {
          const status = line.slice(tag.length + 1).split(/\s+/u, 1)[0]?.toUpperCase();
          if (status !== "OK" && status !== "NO" && status !== "BAD") {
            this.protocolHealthy = false;
            throw new AlibabaImapError("PROTOCOL", "Invalid tagged IMAP response");
          }
          return { lines, status };
        }
        lines.push(line);
        if (lines.length > 10_000) {
          this.protocolHealthy = false;
          throw new AlibabaImapError("LIMIT_EXCEEDED", "Too many IMAP response lines");
        }
      }
    } catch (error) {
      // A transport/read failure can leave a command in flight. Do not issue a
      // second command (including LOGOUT) on the same stream in that state.
      this.protocolHealthy = false;
      throw error;
    }
  }

  private async login(): Promise<void> {
    // Never preserve this command or include the server's response in an error.
    const response = await this.command(
      `LOGIN ${quoteImapString(this.email)} ${quoteImapString(this.password)}`,
    );
    this.password = "";
    if (response.status !== "OK") {
      throw new AlibabaImapError(
        "AUTHENTICATION",
        "Alibaba Mail credentials were rejected",
      );
    }
    this.authenticated = true;
  }

  async noop(): Promise<void> {
    const response = await this.command("NOOP");
    if (response.status !== "OK") {
      throw new AlibabaImapError("PROTOCOL", "Alibaba Mail NOOP failed");
    }
  }

  async examineInbox(): Promise<MailboxSelection> {
    const response = await this.command(`EXAMINE ${quoteImapString("INBOX")}`);
    if (response.status !== "OK") {
      throw new AlibabaImapError("PROTOCOL", "Unable to examine the inbox");
    }
    let uidValidity: string | null = null;
    let uidNext: number | null = null;
    for (const line of response.lines) {
      const validityMatch = line.match(/\[UIDVALIDITY\s+(\d+)\]/iu);
      if (validityMatch) uidValidity = validityMatch[1];
      const nextMatch = line.match(/\[UIDNEXT\s+(\d+)\]/iu);
      if (nextMatch) uidNext = Number(nextMatch[1]);
    }
    if (!uidValidity) {
      throw new AlibabaImapError("PROTOCOL", "Inbox UIDVALIDITY was not provided");
    }
    return { uidValidity, uidNext };
  }

  async searchUidsAfter(sinceUid: number, sinceDate?: string): Promise<number[]> {
    if (!Number.isSafeInteger(sinceUid) || sinceUid < 0) {
      throw new AlibabaImapError("CONFIGURATION", "Invalid starting UID");
    }
    let dateCriterion = "";
    if (sinceDate !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(sinceDate)) {
        throw new AlibabaImapError("CONFIGURATION", "Invalid collection start date");
      }
      const [year, month, day] = sinceDate.split("-").map(Number);
      const date = new Date(Date.UTC(year, month - 1, day));
      if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
        throw new AlibabaImapError("CONFIGURATION", "Invalid collection start date");
      }
      const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      dateCriterion = ` SINCE ${day}-${months[month - 1]}-${year}`;
    }
    const firstUid = sinceUid + 1;
    const response = await this.command(`UID SEARCH UID ${firstUid}:*${dateCriterion}`);
    if (response.status !== "OK") {
      throw new AlibabaImapError("PROTOCOL", "Alibaba Mail UID search failed");
    }
    const found = new Set<number>();
    for (const line of response.lines) {
      const match = line.match(/^\*\s+SEARCH(?:\s+(.*))?$/iu);
      if (!match?.[1]) continue;
      for (const token of match[1].trim().split(/\s+/u)) {
        if (!/^\d+$/u.test(token)) continue;
        const uid = Number(token);
        if (Number.isSafeInteger(uid) && uid > sinceUid) found.add(uid);
      }
    }
    return [...found].sort((left, right) => left - right);
  }

  async fetchMessage(uid: number, maxMessageBytes: number): Promise<FetchedImapMessage> {
    try {
      return await this.fetchMessageUnchecked(uid, maxMessageBytes);
    } catch (error) {
      // A failed literal read cannot be safely followed by another IMAP command.
      this.abort();
      throw error;
    }
  }

  private async fetchMessageUnchecked(
    uid: number,
    maxMessageBytes: number,
  ): Promise<FetchedImapMessage> {
    if (!Number.isSafeInteger(uid) || uid < 1) {
      throw new AlibabaImapError("CONFIGURATION", "Invalid message UID");
    }
    const byteLimit = boundedInteger(
      maxMessageBytes,
      maxMessageBytes,
      1024,
      64 * 1024 * 1024,
      "message byte limit",
    );
    const tag = this.nextTag();
    // Alibaba's documented implementation does not support a 2:3 FETCH range;
    // callers invoke this method once per UID.
    await this.wire.sendLine(
      `${tag} UID FETCH ${uid} (UID RFC822.SIZE INTERNALDATE BODY.PEEK[])`,
    );

    let rawBytes: Uint8Array | null = null;
    let returnedUid: number | null = null;
    let internalDate: string | null = null;
    while (true) {
      const line = await this.wire.readLine();
      if (/^\*\s+BYE\b/iu.test(line)) {
        this.protocolHealthy = false;
        throw new AlibabaImapError("CONNECTION", "Alibaba Mail closed the session");
      }

      if (line.startsWith(`${tag} `)) {
        const status = line.slice(tag.length + 1).split(/\s+/u, 1)[0]?.toUpperCase();
        if (status !== "OK") {
          throw new AlibabaImapError("PROTOCOL", "Alibaba Mail UID fetch failed");
        }
        break;
      }

      const uidMatch = line.match(/\bUID\s+(\d+)\b/iu);
      if (uidMatch) returnedUid = Number(uidMatch[1]);
      const dateMatch = line.match(/\bINTERNALDATE\s+"((?:[^"\\]|\\.)*)"/iu);
      if (dateMatch) internalDate = dateMatch[1].replace(/\\(["\\])/gu, "$1");

      const literalMatch = line.match(/\{(\d+)\}\s*$/u);
      if (!literalMatch) continue;
      const literalLength = Number(literalMatch[1]);
      if (!Number.isSafeInteger(literalLength) || literalLength < 0) {
        this.protocolHealthy = false;
        throw new AlibabaImapError("PROTOCOL", "Invalid message literal length");
      }
      if (literalLength > byteLimit) {
        // Do not download/drain an attacker-controlled oversized literal. Closing
        // the TLS socket in finally is safer than trying to resynchronise it.
        this.protocolHealthy = false;
        throw new AlibabaImapError("LIMIT_EXCEEDED", "Message exceeds byte limit");
      }
      if (rawBytes) {
        this.protocolHealthy = false;
        throw new AlibabaImapError("PROTOCOL", "Unexpected extra message literal");
      }
      rawBytes = await this.wire.readExactly(literalLength);
    }

    if (!rawBytes || returnedUid !== uid) {
      throw new AlibabaImapError("PROTOCOL", "Fetched message UID did not match");
    }
    return { uid, internalDate, rawBytes };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.password = "";
    if (this.authenticated && this.protocolHealthy) {
      try {
        await this.command("LOGOUT");
      } catch {
        // Socket close below is mandatory even if LOGOUT gets no response.
      }
    }
    await this.wire.close();
  }

  /** Immediately prevents further protocol commands; close() still closes TLS. */
  abort(): void {
    this.protocolHealthy = false;
  }
}

function findHeaderEnd(bytes: Uint8Array, limit: number): [number, number] {
  const scanLength = Math.min(bytes.byteLength, limit + 4);
  for (let index = 0; index < scanLength; index += 1) {
    if (
      index + 3 < scanLength &&
      bytes[index] === 13 &&
      bytes[index + 1] === 10 &&
      bytes[index + 2] === 13 &&
      bytes[index + 3] === 10
    ) {
      return [index, 4];
    }
    if (index + 1 < scanLength && bytes[index] === 10 && bytes[index + 1] === 10) {
      return [index, 2];
    }
  }
  if (bytes.byteLength > limit) {
    throw new AlibabaImapError("LIMIT_EXCEEDED", "MIME header limit exceeded");
  }
  return [bytes.byteLength, 0];
}

function decodeBytes(bytes: Uint8Array, charset: string): string {
  const normalized = charset.trim().toLowerCase().replace(/^"|"$/gu, "");
  const labels: Record<string, string> = {
    "utf8": "utf-8",
    "us-ascii": "windows-1252",
    "iso-8859-1": "windows-1252",
    "gb2312": "gb18030",
    "gbk": "gb18030",
  };
  try {
    return new TextDecoder(labels[normalized] ?? normalized, { fatal: false }).decode(bytes);
  } catch {
    return utf8Decoder.decode(bytes);
  }
}

function decodeBase64(value: string, maxBytes: number): Uint8Array {
  const compact = value.replace(/[\t\r\n ]+/gu, "");
  if (compact.length === 0) return new Uint8Array(0);
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(compact) || compact.length % 4 === 1) {
    throw new AlibabaImapError("MIME", "Invalid MIME base64 data");
  }
  const estimated = Math.floor((compact.length * 3) / 4);
  if (estimated > maxBytes + 2) {
    throw new AlibabaImapError("LIMIT_EXCEEDED", "Attachment exceeds byte limit");
  }
  const padded = compact.padEnd(Math.ceil(compact.length / 4) * 4, "=");
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new AlibabaImapError("MIME", "Invalid MIME base64 data");
  }
  if (binary.length > maxBytes) {
    throw new AlibabaImapError("LIMIT_EXCEEDED", "Attachment exceeds byte limit");
  }
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    result[index] = binary.charCodeAt(index);
  }
  return result;
}

function base64Value(byte: number): number {
  if (byte >= 0x41 && byte <= 0x5a) return byte - 0x41;
  if (byte >= 0x61 && byte <= 0x7a) return byte - 0x61 + 26;
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30 + 52;
  if (byte === 0x2b) return 62;
  if (byte === 0x2f) return 63;
  return -1;
}

/** Decode a MIME base64 body without first materialising multi-MiB strings. */
function decodeBase64Bytes(bytes: Uint8Array, maxBytes: number): Uint8Array {
  let symbols = 0;
  let padding = 0;
  let sawPadding = false;
  for (const byte of bytes) {
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x20) continue;
    if (byte === 0x3d) {
      sawPadding = true;
      padding += 1;
      symbols += 1;
      if (padding > 2) throw new AlibabaImapError("MIME", "Invalid MIME base64 data");
      continue;
    }
    if (sawPadding || base64Value(byte) < 0) {
      throw new AlibabaImapError("MIME", "Invalid MIME base64 data");
    }
    symbols += 1;
  }
  if (symbols === 0) return new Uint8Array(0);
  if (symbols % 4 === 1 || (padding > 0 && symbols % 4 !== 0)) {
    throw new AlibabaImapError("MIME", "Invalid MIME base64 data");
  }
  const decodedLength = Math.floor((symbols * 3) / 4) - padding;
  if (decodedLength > maxBytes) {
    throw new AlibabaImapError("LIMIT_EXCEEDED", "Attachment exceeds byte limit");
  }

  const output = new Uint8Array(decodedLength);
  const quartet = new Uint8Array(4);
  let quartetLength = 0;
  let outputIndex = 0;
  for (const byte of bytes) {
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x20) continue;
    quartet[quartetLength] = byte;
    quartetLength += 1;
    if (quartetLength !== 4) continue;
    const a = base64Value(quartet[0]);
    const b = base64Value(quartet[1]);
    const c = quartet[2] === 0x3d ? 0 : base64Value(quartet[2]);
    const d = quartet[3] === 0x3d ? 0 : base64Value(quartet[3]);
    if (a < 0 || b < 0 || c < 0 || d < 0) {
      throw new AlibabaImapError("MIME", "Invalid MIME base64 data");
    }
    if (outputIndex < output.length) output[outputIndex++] = (a << 2) | (b >> 4);
    if (outputIndex < output.length) output[outputIndex++] = ((b & 15) << 4) | (c >> 2);
    if (outputIndex < output.length) output[outputIndex++] = ((c & 3) << 6) | d;
    quartetLength = 0;
  }

  // RFC 2045 commonly omits padding in malformed-but-readable mail. Decode a
  // final 2/3-symbol quantum, but reject a lone symbol.
  if (quartetLength === 1) throw new AlibabaImapError("MIME", "Invalid MIME base64 data");
  if (quartetLength >= 2) {
    const a = base64Value(quartet[0]);
    const b = base64Value(quartet[1]);
    const c = quartetLength === 3 ? base64Value(quartet[2]) : 0;
    if (a < 0 || b < 0 || c < 0) throw new AlibabaImapError("MIME", "Invalid MIME base64 data");
    if (outputIndex < output.length) output[outputIndex++] = (a << 2) | (b >> 4);
    if (quartetLength === 3 && outputIndex < output.length) {
      output[outputIndex++] = ((b & 15) << 4) | (c >> 2);
    }
  }
  return output;
}

function decodeQuotedPrintable(bytes: Uint8Array, maxBytes: number): Uint8Array {
  if (bytes.byteLength > maxBytes * 4 + 16) {
    throw new AlibabaImapError("LIMIT_EXCEEDED", "Attachment exceeds byte limit");
  }
  const output = new Uint8Array(Math.min(bytes.byteLength, maxBytes + 1));
  let outputIndex = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (outputIndex > maxBytes) {
      throw new AlibabaImapError("LIMIT_EXCEEDED", "Attachment exceeds byte limit");
    }
    if (bytes[index] !== 0x3d) {
      output[outputIndex] = bytes[index];
      outputIndex += 1;
      continue;
    }
    if (bytes[index + 1] === 0x0d && bytes[index + 2] === 0x0a) {
      index += 2;
      continue;
    }
    if (bytes[index + 1] === 0x0a) {
      index += 1;
      continue;
    }
    const hex = String.fromCharCode(bytes[index + 1] ?? 0, bytes[index + 2] ?? 0);
    if (/^[0-9A-Fa-f]{2}$/u.test(hex)) {
      output[outputIndex] = Number.parseInt(hex, 16);
      outputIndex += 1;
      index += 2;
      continue;
    }
    // RFC 2045 says malformed '=' is invalid; preserve it for compatibility with
    // common mail clients instead of silently dropping user data.
    output[outputIndex] = bytes[index];
    outputIndex += 1;
  }
  if (outputIndex > maxBytes) {
    throw new AlibabaImapError("LIMIT_EXCEEDED", "Attachment exceeds byte limit");
  }
  return output.slice(0, outputIndex);
}

export function decodeRfc2047(value: string): string {
  let joined = value;
  const encodedWord = "=\\?[^?\\s]+\\?[bBqQ]\\?[^?]*\\?=";
  const adjacent = new RegExp(`(${encodedWord})[\\t ]+(?=${encodedWord})`, "gu");
  while (adjacent.test(joined)) joined = joined.replace(adjacent, "$1");

  return joined.replace(
    /=\?([^?\s]+)\?([bBqQ])\?([^?]*)\?=/gu,
    (original, charset: string, encoding: string, content: string) => {
      try {
        let bytes: Uint8Array;
        if (encoding.toUpperCase() === "B") {
          bytes = decodeBase64(content, 64 * 1024);
        } else {
          const ascii = utf8Encoder.encode(content.replaceAll("_", " "));
          bytes = decodeQuotedPrintable(ascii, 64 * 1024);
        }
        return decodeBytes(bytes, charset);
      } catch {
        return original;
      }
    },
  );
}

function parseHeaders(bytes: Uint8Array): Map<string, string> {
  const text = utf8Decoder.decode(bytes).replace(/\r?\n[\t ]+/gu, " ");
  const headers = new Map<string, string>();
  for (const line of text.split(/\r?\n/gu)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    if (!/^[a-z0-9-]+$/u.test(name)) continue;
    const value = line.slice(separator + 1).trim();
    const existing = headers.get(name);
    headers.set(name, existing ? `${existing}, ${value}` : value);
  }
  return headers;
}

interface StructuredHeader {
  value: string;
  parameters: Map<string, string>;
}

function splitSemicolonAware(value: string): string[] {
  const result: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
    } else if (character === "\\" && quoted) {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === ";" && !quoted) {
      result.push(value.slice(start, index));
      start = index + 1;
    }
  }
  result.push(value.slice(start));
  return result;
}

function unquoteParameter(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\(["\\])/gu, "$1");
  }
  return trimmed;
}

function parseStructuredHeader(raw: string | undefined, fallback: string): StructuredHeader {
  const pieces = splitSemicolonAware(raw ?? fallback);
  const parameters = new Map<string, string>();
  for (const piece of pieces.slice(1)) {
    const equals = piece.indexOf("=");
    if (equals <= 0) continue;
    const name = piece.slice(0, equals).trim().toLowerCase();
    if (!/^[a-z0-9*_-]+$/u.test(name)) continue;
    parameters.set(name, unquoteParameter(piece.slice(equals + 1)));
  }
  return { value: pieces[0].trim().toLowerCase() || fallback, parameters };
}

function percentDecode(value: string): Uint8Array {
  const output: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "%" && /^[0-9A-Fa-f]{2}$/u.test(value.slice(index + 1, index + 3))) {
      output.push(Number.parseInt(value.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      const encoded = utf8Encoder.encode(value[index]);
      output.push(...encoded);
    }
  }
  return Uint8Array.from(output);
}

function decodeExtendedParameter(value: string): string {
  const match = value.match(/^([^']*)'[^']*'([\s\S]*)$/u);
  if (!match) return decodeRfc2047(value);
  return decodeBytes(percentDecode(match[2]), match[1] || "utf-8");
}

function getFilename(parameters: Map<string, string>): string | null {
  const extended = parameters.get("filename*") ?? parameters.get("name*");
  let candidate: string | undefined;
  if (extended !== undefined) {
    candidate = decodeExtendedParameter(extended);
  } else {
    for (const base of ["filename", "name"]) {
      const segments: string[] = [];
      let encoded = false;
      for (let index = 0; index < 20; index += 1) {
        const starred = parameters.get(`${base}*${index}*`);
        const plain = parameters.get(`${base}*${index}`);
        if (starred === undefined && plain === undefined) break;
        encoded ||= starred !== undefined;
        segments.push(starred ?? plain ?? "");
      }
      if (segments.length > 0) {
        candidate = encoded ? decodeExtendedParameter(segments.join("")) : segments.join("");
        break;
      }
      const simple = parameters.get(base);
      if (simple !== undefined) {
        candidate = decodeRfc2047(simple);
        break;
      }
    }
  }
  if (!candidate) return null;
  const withoutControls = Array.from(candidate, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127 ? "" : character;
  }).join("");
  const safe = withoutControls
    .replace(/[\\/]/gu, "_")
    .trim()
    .slice(0, 255);
  return safe || null;
}

function transferDecode(
  bytes: Uint8Array,
  encoding: string,
  maxBytes: number,
): Uint8Array {
  const normalized = encoding.trim().toLowerCase();
  if (normalized === "base64") {
    return decodeBase64Bytes(bytes, maxBytes);
  }
  if (normalized === "quoted-printable") {
    return decodeQuotedPrintable(bytes, maxBytes);
  }
  if (!["", "7bit", "8bit", "binary"].includes(normalized)) {
    throw new AlibabaImapError("MIME", "Unsupported MIME transfer encoding");
  }
  if (bytes.byteLength > maxBytes) {
    throw new AlibabaImapError("LIMIT_EXCEEDED", "Attachment exceeds byte limit");
  }
  return bytes.subarray(0);
}

function bytesEqualAscii(bytes: Uint8Array, start: number, end: number, ascii: string): boolean {
  if (end - start !== ascii.length) return false;
  for (let index = 0; index < ascii.length; index += 1) {
    if (bytes[start + index] !== ascii.charCodeAt(index)) return false;
  }
  return true;
}

function splitMultipartBody(body: Uint8Array, boundary: string): Uint8Array[] {
  if (boundary.length < 1 || boundary.length > 200 || /[\r\n\0]/u.test(boundary)) {
    throw new AlibabaImapError("MIME", "Invalid MIME multipart boundary");
  }
  const delimiter = `--${boundary}`;
  const closing = `${delimiter}--`;
  const parts: Uint8Array[] = [];
  let partStart: number | null = null;
  let lineStart = 0;

  for (let index = 0; index <= body.byteLength; index += 1) {
    if (index < body.byteLength && body[index] !== 0x0a) continue;
    let lineEnd = index;
    if (lineEnd > lineStart && body[lineEnd - 1] === 0x0d) lineEnd -= 1;
    let meaningfulEnd = lineEnd;
    while (
      meaningfulEnd > lineStart &&
      (body[meaningfulEnd - 1] === 0x20 || body[meaningfulEnd - 1] === 0x09)
    ) {
      meaningfulEnd -= 1;
    }
    const isOpening = bytesEqualAscii(body, lineStart, meaningfulEnd, delimiter);
    const isClosing = bytesEqualAscii(body, lineStart, meaningfulEnd, closing);
    if (isOpening || isClosing) {
      if (partStart !== null) {
        let partEnd = lineStart;
        if (partEnd >= 2 && body[partEnd - 2] === 0x0d && body[partEnd - 1] === 0x0a) {
          partEnd -= 2;
        } else if (partEnd >= 1 && body[partEnd - 1] === 0x0a) {
          partEnd -= 1;
        }
        parts.push(body.subarray(partStart, Math.max(partStart, partEnd)));
      }
      if (isClosing) return parts;
      partStart = index < body.byteLength ? index + 1 : index;
    }
    lineStart = index + 1;
  }
  if (partStart !== null) {
    throw new AlibabaImapError("MIME", "Unterminated MIME multipart body");
  }
  return parts;
}

interface MimeContext {
  readonly limits: Required<MimeParseLimits>;
  parts: number;
  totalAttachmentBytes: number;
  attachments: MimeAttachment[];
}

function parseMimeEntity(bytes: Uint8Array, context: MimeContext, depth: number): void {
  context.parts += 1;
  if (context.parts > context.limits.maxParts || depth > context.limits.maxDepth) {
    throw new AlibabaImapError("LIMIT_EXCEEDED", "MIME structure limit exceeded");
  }
  const [headerEnd, separatorLength] = findHeaderEnd(bytes, context.limits.maxHeaderBytes);
  const headers = parseHeaders(bytes.subarray(0, headerEnd));
  const body = bytes.subarray(headerEnd + separatorLength);
  const contentType = parseStructuredHeader(headers.get("content-type"), "text/plain");
  const disposition = parseStructuredHeader(headers.get("content-disposition"), "");

  if (contentType.value.startsWith("multipart/")) {
    const boundary = contentType.parameters.get("boundary");
    if (!boundary) throw new AlibabaImapError("MIME", "MIME boundary is missing");
    for (const part of splitMultipartBody(body, boundary)) {
      parseMimeEntity(part, context, depth + 1);
    }
    return;
  }

  const filename = getFilename(disposition.parameters) ?? getFilename(contentType.parameters);
  const isAttachment = disposition.value === "attachment" || filename !== null;
  if (!isAttachment) {
    if (contentType.value === "message/rfc822") {
      const nested = transferDecode(
        body,
        headers.get("content-transfer-encoding") ?? "",
        context.limits.maxAttachmentBytes,
      );
      parseMimeEntity(nested, context, depth + 1);
    }
    return;
  }
  if (context.attachments.length >= context.limits.maxAttachments) {
    throw new AlibabaImapError("LIMIT_EXCEEDED", "Too many MIME attachments");
  }
  const decoded = transferDecode(
    body,
    headers.get("content-transfer-encoding") ?? "",
    context.limits.maxAttachmentBytes,
  );
  context.totalAttachmentBytes += decoded.byteLength;
  if (context.totalAttachmentBytes > context.limits.maxTotalAttachmentBytes) {
    throw new AlibabaImapError("LIMIT_EXCEEDED", "Total attachment byte limit exceeded");
  }
  context.attachments.push({
    filename: filename ?? `attachment-${context.attachments.length + 1}`,
    contentType: contentType.value.slice(0, 255),
    bytes: decoded,
  });
}

function trimMetadata(value: string | undefined, maximum: number): string | null {
  if (!value) return null;
  const clean = decodeRfc2047(value).replace(/[\r\n\0]/gu, " ").trim().slice(0, maximum);
  return clean || null;
}

function parseFrom(value: string | undefined): { name: string | null; address: string | null } {
  const decoded = trimMetadata(value, 1000);
  if (!decoded) return { name: null, address: null };
  const angle = decoded.match(/^(.*)<\s*([^<>\s@]+@[^<>\s@]+)\s*>/u);
  if (angle) {
    const name = angle[1].trim().replace(/^"|"$/gu, "").trim();
    return { name: name || null, address: angle[2].slice(0, 320) };
  }
  const address = decoded.match(/(?:^|[\s,(])([^<>\s,;@]+@[^<>\s,;@]+)(?:$|[\s,)])/u);
  return { name: null, address: address?.[1]?.slice(0, 320) ?? null };
}

function parseDate(value: string | undefined, fallback: string | null): string | null {
  for (const candidate of [value, fallback]) {
    if (!candidate) continue;
    const timestamp = Date.parse(candidate);
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  }
  return null;
}

export function parseRfc822Message(
  rawBytes: Uint8Array,
  limits: MimeParseLimits = {},
  internalDate: string | null = null,
): ParsedMailMessage {
  const resolved: Required<MimeParseLimits> = {
    maxHeaderBytes: boundedInteger(limits.maxHeaderBytes, 128 * 1024, 1024, 1024 * 1024, "header limit"),
    maxParts: boundedInteger(limits.maxParts, 100, 1, 1000, "MIME part limit"),
    maxDepth: boundedInteger(limits.maxDepth, 10, 1, 30, "MIME depth limit"),
    maxAttachments: boundedInteger(limits.maxAttachments, 30, 1, 200, "attachment count limit"),
    maxAttachmentBytes: boundedInteger(
      limits.maxAttachmentBytes,
      16 * 1024 * 1024,
      1024,
      64 * 1024 * 1024,
      "attachment byte limit",
    ),
    maxTotalAttachmentBytes: boundedInteger(
      limits.maxTotalAttachmentBytes,
      32 * 1024 * 1024,
      1024,
      96 * 1024 * 1024,
      "total attachment byte limit",
    ),
  };
  const [headerEnd] = findHeaderEnd(rawBytes, resolved.maxHeaderBytes);
  const headers = parseHeaders(rawBytes.subarray(0, headerEnd));
  const from = parseFrom(headers.get("from"));
  const context: MimeContext = {
    limits: resolved,
    parts: 0,
    totalAttachmentBytes: 0,
    attachments: [],
  };
  parseMimeEntity(rawBytes, context, 0);
  return {
    messageId: trimMetadata(headers.get("message-id"), 998),
    subject: trimMetadata(headers.get("subject"), 998) ?? "",
    fromName: from.name,
    fromAddress: from.address,
    receivedAt: parseDate(headers.get("date"), internalDate),
    attachments: context.attachments,
  };
}

export async function withAlibabaImapSession<T>(
  options: AlibabaImapOptions,
  operation: (session: AlibabaImapSession) => Promise<T>,
): Promise<T> {
  const overallTimeoutMs = boundedInteger(
    options.overallTimeoutMs,
    DEFAULT_OVERALL_TIMEOUT_MS,
    2_000,
    120_000,
    "overall timeout",
  );
  const session = await AlibabaImapSession.open(options);
  const overallTimeout = new AlibabaImapError(
    "TIMEOUT",
    "Alibaba Mail operation timed out",
  );
  try {
    return await deadline(
      operation(session),
      overallTimeoutMs,
      overallTimeout,
    );
  } catch (error) {
    if (error === overallTimeout) session.abort();
    throw error;
  } finally {
    await session.close();
  }
}
