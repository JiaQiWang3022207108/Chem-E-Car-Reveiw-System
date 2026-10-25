import {
  ALIBABA_IMAP_HOST,
  ALIBABA_IMAP_PORT,
  AlibabaImapError,
  type AlibabaImapOptions,
  type ImapSocketFactory,
  parseRfc822Message,
  withAlibabaImapSession,
} from "./alibaba-imap";

const CREDENTIAL_AAD = new TextEncoder().encode("chem-e-car:mail-credential:v1");
const credentialEncoder = new TextEncoder();
const credentialDecoder = new TextDecoder("utf-8", { fatal: true });

export interface AlibabaMailConnectionInput {
  host?: string;
  port?: number;
  email: string;
  password: string;
  timeoutMs?: number;
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
  overallTimeoutMs?: number;
  /** Intended only for isolated protocol tests. */
  socketFactory?: ImapSocketFactory;
}

export interface AlibabaMailFetchInput extends AlibabaMailConnectionInput {
  sinceUid?: number;
  /** Only messages whose IMAP internal date is on/after this YYYY-MM-DD are searched. */
  sinceDate?: string | null;
  /** Stored UIDVALIDITY. A different server value resets collection to UID 0. */
  expectedUidValidity?: string | null;
  maxMessages?: number;
  maxTotalBytes?: number;
  maxMessageBytes?: number;
  maxAttachmentBytes?: number;
  maxTotalAttachmentBytes?: number;
  /** Persist a UIDVALIDITY reset before any message callback runs. */
  onUidValidityReset?: (uidValidity: string) => Promise<void>;
  /** Called once per parsed message; resolve only after bytes and metadata commit. */
  onMessage?: (message: CollectedMailMessage, uidValidity: string) => Promise<void>;
  /** Called for a permanent, message-specific failure; resolve only after issue + checkpoint commit. */
  onPermanentMessageError?: (failure: PermanentMailMessageFailure) => Promise<void>;
}

export interface CollectedMailAttachment {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface CollectedMailMessage {
  uid: number;
  messageId: string | null;
  subject: string;
  fromName: string | null;
  fromAddress: string | null;
  receivedAt: string | null;
  rawBytes: Uint8Array;
  attachments: CollectedMailAttachment[];
}

export interface AlibabaMailFetchResult {
  uidValidity: string;
  /** Last UID actually returned; persist this only after the result is committed. */
  highestUid: number;
  processedCount: number;
  skippedCount: number;
  /** Empty when onMessage is supplied, avoiding retention of the whole batch. */
  messages: CollectedMailMessage[];
  hasMore: boolean;
}

export interface PermanentMailMessageFailure {
  uid: number;
  uidValidity: string;
  error: AlibabaImapError;
}

export interface AlibabaMailConnectionResult {
  ok: true;
  host: typeof ALIBABA_IMAP_HOST;
  port: typeof ALIBABA_IMAP_PORT;
  uidValidity: string;
}

export interface CredentialEncryptionEnv {
  APP_CREDENTIAL_ENCRYPTION_KEY?: string;
}

function safeInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new AlibabaImapError("CONFIGURATION", `Invalid ${label}`);
  }
  return result;
}

function imapOptions(input: AlibabaMailConnectionInput, maxWireBytes?: number): AlibabaImapOptions {
  return {
    host: input.host ?? ALIBABA_IMAP_HOST,
    port: input.port ?? ALIBABA_IMAP_PORT,
    email: input.email,
    password: input.password,
    connectTimeoutMs: input.connectTimeoutMs ?? input.timeoutMs,
    commandTimeoutMs: input.commandTimeoutMs ?? input.timeoutMs,
    overallTimeoutMs: input.overallTimeoutMs ?? input.timeoutMs,
    maxWireBytes,
    socketFactory: input.socketFactory,
  };
}

export async function testAlibabaMailConnection(
  input: AlibabaMailConnectionInput,
): Promise<AlibabaMailConnectionResult> {
  return withAlibabaImapSession(imapOptions(input, 1024 * 1024), async (session) => {
    await session.noop();
    const mailbox = await session.examineInbox();
    return {
      ok: true,
      host: ALIBABA_IMAP_HOST,
      port: ALIBABA_IMAP_PORT,
      uidValidity: mailbox.uidValidity,
    };
  });
}

export async function fetchAlibabaMailIncremental(
  input: AlibabaMailFetchInput,
): Promise<AlibabaMailFetchResult> {
  const storedSinceUid = safeInteger(input.sinceUid, 0, 0, Number.MAX_SAFE_INTEGER - 1, "starting UID");
  const maxMessages = safeInteger(input.maxMessages, 25, 1, 100, "message count limit");
  const maxTotalBytes = safeInteger(
    input.maxTotalBytes,
    32 * 1024 * 1024,
    1024,
    96 * 1024 * 1024,
    "total byte limit",
  );
  const maxMessageBytes = safeInteger(
    input.maxMessageBytes,
    Math.min(16 * 1024 * 1024, maxTotalBytes),
    1024,
    Math.min(64 * 1024 * 1024, maxTotalBytes),
    "message byte limit",
  );
  const maxAttachmentBytes = safeInteger(
    input.maxAttachmentBytes,
    Math.min(12 * 1024 * 1024, maxMessageBytes),
    1024,
    Math.min(64 * 1024 * 1024, maxMessageBytes),
    "attachment byte limit",
  );
  const maxTotalAttachmentBytes = safeInteger(
    input.maxTotalAttachmentBytes,
    Math.min(24 * 1024 * 1024, maxTotalBytes),
    1024,
    Math.min(96 * 1024 * 1024, maxTotalBytes),
    "total attachment byte limit",
  );
  const sinceDate = input.sinceDate === null || input.sinceDate === undefined || input.sinceDate === ""
    ? undefined
    : input.sinceDate;
  if (sinceDate !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(sinceDate)) {
      throw new AlibabaImapError("CONFIGURATION", "Invalid collection start date");
    }
    const [year, month, day] = sinceDate.split("-").map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
      throw new AlibabaImapError("CONFIGURATION", "Invalid collection start date");
    }
  }

  // Leave room to inspect one message beyond the remaining batch budget without
  // turning a normal backlog boundary into a false per-message limit error.
  const maxWireBytes = Math.min(
    128 * 1024 * 1024,
    maxTotalBytes + maxMessageBytes + 4 * 1024 * 1024,
  );
  return withAlibabaImapSession(imapOptions(input, maxWireBytes), async (session) => {
    const mailbox = await session.examineInbox();
    const validityChanged = input.expectedUidValidity !== undefined
      && input.expectedUidValidity !== mailbox.uidValidity;
    const sinceUid = validityChanged ? 0 : storedSinceUid;
    if (validityChanged && input.onUidValidityReset) {
      await input.onUidValidityReset(mailbox.uidValidity);
    }

    if (mailbox.uidNext !== null && sinceUid + 1 >= mailbox.uidNext) {
      return {
        uidValidity: mailbox.uidValidity,
        highestUid: sinceUid,
        processedCount: 0,
        skippedCount: 0,
        messages: [],
        hasMore: false,
      };
    }

    const allUids = await session.searchUidsAfter(sinceUid, sinceDate);
    const selectedUids = allUids.slice(0, maxMessages);
    const messages: CollectedMailMessage[] = [];
    let totalBytes = 0;
    let highestUid = sinceUid;
    let processedCount = 0;
    let skippedCount = 0;

    for (const uid of selectedUids) {
      let fetched: Awaited<ReturnType<typeof session.fetchMessage>>;
      try {
        fetched = await session.fetchMessage(uid, maxMessageBytes);
      } catch (error) {
        // A literal larger than the per-message ceiling is permanently tied to
        // this UID. fetchMessage aborts the now-unsynchronised session, so commit
        // the issue/checkpoint and let the next run continue at UID + 1.
        if (
          error instanceof AlibabaImapError
          && error.code === "LIMIT_EXCEEDED"
          && input.onPermanentMessageError
        ) {
          await input.onPermanentMessageError({ uid, uidValidity: mailbox.uidValidity, error });
          highestUid = uid;
          skippedCount += 1;
          return {
            uidValidity: mailbox.uidValidity,
            highestUid,
            processedCount,
            skippedCount,
            messages,
            hasMore: allUids.some((candidate) => candidate > uid),
          };
        }
        throw error;
      }

      if (totalBytes + fetched.rawBytes.byteLength > maxTotalBytes) {
        // This UID itself is valid; it merely belongs in the next bounded run.
        return {
          uidValidity: mailbox.uidValidity,
          highestUid,
          processedCount,
          skippedCount,
          messages,
          hasMore: true,
        };
      }
      totalBytes += fetched.rawBytes.byteLength;

      let parsed: ReturnType<typeof parseRfc822Message>;
      try {
        parsed = parseRfc822Message(
          fetched.rawBytes,
          {
            maxAttachmentBytes,
            maxTotalAttachmentBytes,
            maxAttachments: 30,
            maxParts: 100,
            maxDepth: 10,
          },
          fetched.internalDate,
        );
      } catch (error) {
        if (
          error instanceof AlibabaImapError
          && (error.code === "LIMIT_EXCEEDED" || error.code === "MIME")
          && input.onPermanentMessageError
        ) {
          await input.onPermanentMessageError({ uid, uidValidity: mailbox.uidValidity, error });
          highestUid = uid;
          skippedCount += 1;
          continue;
        }
        throw error;
      }

      const message: CollectedMailMessage = {
        uid,
        messageId: parsed.messageId,
        subject: parsed.subject,
        fromName: parsed.fromName,
        fromAddress: parsed.fromAddress,
        receivedAt: parsed.receivedAt,
        rawBytes: fetched.rawBytes,
        attachments: parsed.attachments,
      };
      if (input.onMessage) {
        await input.onMessage(message, mailbox.uidValidity);
      } else {
        messages.push(message);
      }
      highestUid = uid;
      processedCount += 1;
    }

    return {
      uidValidity: mailbox.uidValidity,
      highestUid,
      processedCount,
      skippedCount,
      messages,
      hasMore: allUids.length > selectedUids.length,
    };
  });
}

function decodeBase64Url(value: string): Uint8Array {
  const unpadded = value.replace(/=+$/u, "");
  if (!/^[A-Za-z0-9_-]+$/u.test(unpadded)) throw new Error("Invalid base64url value");
  const standard = unpadded.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Error("Invalid base64url value");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.byteLength; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function importCredentialKey(keyB64url: string): Promise<CryptoKey> {
  let keyBytes: Uint8Array;
  try {
    keyBytes = decodeBase64Url(keyB64url);
  } catch {
    throw new AlibabaImapError("CONFIGURATION", "Invalid credential encryption key");
  }
  if (keyBytes.byteLength !== 32) {
    keyBytes.fill(0);
    throw new AlibabaImapError("CONFIGURATION", "Credential encryption key must be 32 bytes");
  }
  try {
    return await crypto.subtle.importKey("raw", ownedArrayBuffer(keyBytes), { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt",
    ]);
  } finally {
    keyBytes.fill(0);
  }
}

/** Encrypts one mailbox password for D1 storage. The plaintext is never logged. */
export async function encryptCredential(password: string, keyB64url: string): Promise<string> {
  const plaintext = credentialEncoder.encode(password);
  if (plaintext.byteLength < 1 || plaintext.byteLength > 4096 || /[\r\n\0]/u.test(password)) {
    plaintext.fill(0);
    throw new AlibabaImapError("CONFIGURATION", "Invalid mailbox password");
  }
  const key = await importCredentialKey(keyB64url);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  try {
    const encrypted = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: ownedArrayBuffer(iv),
        additionalData: ownedArrayBuffer(CREDENTIAL_AAD),
        tagLength: 128,
      },
      key,
      ownedArrayBuffer(plaintext),
    );
    return `v1.${encodeBase64Url(iv)}.${encodeBase64Url(new Uint8Array(encrypted))}`;
  } finally {
    plaintext.fill(0);
  }
}

/** Decrypts a D1 ciphertext. All failures intentionally have the same message. */
export async function decryptCredential(ciphertext: string, keyB64url: string): Promise<string> {
  try {
    const pieces = ciphertext.split(".");
    if (pieces.length !== 3 || pieces[0] !== "v1") throw new Error("format");
    const iv = decodeBase64Url(pieces[1]);
    const encrypted = decodeBase64Url(pieces[2]);
    if (iv.byteLength !== 12 || encrypted.byteLength < 17 || encrypted.byteLength > 4112) {
      throw new Error("length");
    }
    const key = await importCredentialKey(keyB64url);
    const decrypted = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: ownedArrayBuffer(iv),
          additionalData: ownedArrayBuffer(CREDENTIAL_AAD),
          tagLength: 128,
        },
        key,
        ownedArrayBuffer(encrypted),
      ),
    );
    try {
      return credentialDecoder.decode(decrypted);
    } finally {
      decrypted.fill(0);
    }
  } catch {
    throw new AlibabaImapError("AUTHENTICATION", "Credential decryption failed");
  }
}

export function credentialKeyFromEnv(env: CredentialEncryptionEnv): string {
  if (!env.APP_CREDENTIAL_ENCRYPTION_KEY) {
    throw new AlibabaImapError("CONFIGURATION", "Credential encryption is not configured");
  }
  return env.APP_CREDENTIAL_ENCRYPTION_KEY;
}

export { AlibabaImapError } from "./alibaba-imap";
