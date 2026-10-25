/* global chrome */
(() => {
  if (globalThis.__chemecarAliMailCollectorLoaded) return;
  globalThis.__chemecarAliMailCollectorLoaded = true;

  const PART_BYTES = 8 * 1024 * 1024;
  const INBOX_PATH = "/alimail/entries/v5.1/mail/inbox/all";
  const collectorState = Object.freeze({
    loggedOut: "logged_out",
    inboxReady: "inbox_ready",
    messageReady: "message_ready",
    unknown: "unknown",
  });
  const supportedFile = /\.(?:ai|jpe?g|mp4|zip|7z|rar)$/iu;
  let running = false;

  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const clean = (value) => typeof value === "string" ? value.normalize("NFKC").replace(/\s+/gu, " ").trim() : "";

  function visible(element) {
    if (!(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 1 && rect.height > 1 && style.display !== "none" && style.visibility !== "hidden";
  }

  function pageState() {
    if (/\/login|signin|passport/iu.test(location.href) || document.querySelector('input[type="password"]')) {
      return collectorState.loggedOut;
    }
    if (location.pathname.includes(INBOX_PATH) || /\/mail\/inbox(?:\/|$)/iu.test(location.pathname)) {
      return collectorState.inboxReady;
    }
    if (/\/mail\/(?:read|detail|message)/iu.test(location.pathname)) return collectorState.messageReady;
    return collectorState.unknown;
  }

  function mailboxKey() {
    const account = document.querySelector('[data-email], [data-account], [title*="@"]');
    return clean(account?.getAttribute("data-email") || account?.getAttribute("data-account") || account?.getAttribute("title") || "alimail-inbox").slice(0, 200) || "alimail-inbox";
  }

  function candidateRows() {
    const selectors = [
      '[role="main"] [role="row"]',
      '[role="main"] [role="listitem"]',
      '[data-testid*="mail-item"]',
      '[data-testid*="message-item"]',
      '[class*="mail-list"] [class*="item"]',
      '[class*="mailList"] [class*="item"]',
    ];
    const rows = [];
    const seen = new Set();
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (!visible(element) || seen.has(element)) continue;
        const text = clean(element.textContent || "");
        if (text.length < 4 || /收件人|主题|写邮件|新建邮件/u.test(text)) continue;
        seen.add(element);
        rows.push(element);
      }
    }
    return rows;
  }

  function parseDisplayedDate(value) {
    const text = clean(value);
    if (!text) return null;
    const direct = Date.parse(text);
    if (Number.isFinite(direct)) return new Date(direct).toISOString();
    const full = text.match(/((?:19|20)\d{2})[年/.-](\d{1,2})[月/.-](\d{1,2})(?:日)?(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/u);
    if (full) {
      const date = new Date(Number(full[1]), Number(full[2]) - 1, Number(full[3]), Number(full[4] || 12), Number(full[5] || 0), Number(full[6] || 0));
      return Number.isFinite(date.getTime()) ? date.toISOString() : null;
    }
    const short = text.match(/(?:^|\s)(\d{1,2})[月/.-](\d{1,2})(?:日)?(?:\s+(\d{1,2}):(\d{2}))?/u);
    if (short) {
      const date = new Date(new Date().getFullYear(), Number(short[1]) - 1, Number(short[2]), Number(short[3] || 12), Number(short[4] || 0));
      return Number.isFinite(date.getTime()) ? date.toISOString() : null;
    }
    return null;
  }

  function rowDate(row) {
    const time = row.querySelector("time");
    const candidates = [
      time?.getAttribute("datetime"),
      time?.getAttribute("title"),
      row.getAttribute("data-time"),
      row.getAttribute("data-date"),
      row.querySelector('[class*="time"], [class*="date"]')?.textContent,
      row.textContent,
    ];
    for (const candidate of candidates) {
      const parsed = parseDisplayedDate(candidate || "");
      if (parsed) return parsed;
    }
    return null;
  }

  function rowSubject(row) {
    const subject = row.querySelector('[data-testid*="subject"], [class*="subject"], [title]');
    const value = clean(subject?.textContent || subject?.getAttribute("title") || "");
    if (value) return value.slice(0, 500);
    return clean((row.textContent || "").split(/\r?\n/u).find(Boolean) || "").slice(0, 500);
  }

  async function sha256(value) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function rowKey(row) {
    const explicit = clean(row.getAttribute("data-id") || row.getAttribute("data-message-id") || row.id);
    return explicit || sha256(`${rowSubject(row)}\0${rowDate(row) || ""}\0${clean(row.textContent || "").slice(0, 1_000)}`);
  }

  function attachmentSize(text) {
    const match = clean(text).match(/(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)/iu);
    if (!match) return 0;
    const units = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };
    return Math.round(Number(match[1]) * (units[match[2].toLocaleUpperCase("en-US")] || 1));
  }

  async function attachmentByteSize(element, downloadUrl) {
    const displayed = attachmentSize(`${element.getAttribute("data-size") || ""} ${element.parentElement?.textContent || element.textContent || ""}`);
    if (displayed > 0) return displayed;
    const response = await fetch(downloadUrl, { method: "HEAD", credentials: "include", cache: "no-store" }).catch(() => null);
    const declared = response?.headers.get("Content-Length") || "";
    return /^\d+$/u.test(declared) && Number.isSafeInteger(Number(declared)) ? Number(declared) : 0;
  }

  function attachmentName(element) {
    const raw = clean(
      element.getAttribute("download") || element.getAttribute("data-file-name") ||
      element.getAttribute("data-filename") || element.getAttribute("title") || element.textContent || "",
    );
    const match = raw.match(/([^\\/:*?"<>|\r\n]+\.(?:ai|jpe?g|mp4|zip|7z|rar))(?:\s|$)/iu);
    return clean(match?.[1] || "").slice(0, 240);
  }

  function attachmentUrl(element) {
    const value = element instanceof HTMLAnchorElement ? element.href : "";
    const raw = value || element.getAttribute("data-download-url") || element.getAttribute("data-url") || "";
    try {
      const url = new URL(raw, location.href);
      return url.protocol === "https:" ? url.href : "";
    } catch {
      return "";
    }
  }

  async function openMessage(row, messageKey) {
    row.scrollIntoView?.({ block: "center" });
    row.click();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await delay(120);
      const region = document.querySelector('[role="main"], [class*="mail-detail"], [class*="read-mail"], [class*="message-detail"]');
      if (region && (supportedFile.test(clean(region.textContent || "")) || attempt > 8)) break;
    }
    const elements = [...document.querySelectorAll([
      'a[download]',
      'a[href*="download"]',
      'a[href*="attachment"]',
      '[data-download-url]',
      '[data-file-name]',
      '[class*="attachment"] a',
      '[class*="attach"] a',
    ].join(","))].filter(visible);
    const attachments = [];
    const seen = new Set();
    for (const element of elements) {
      const filename = attachmentName(element);
      const downloadUrl = attachmentUrl(element);
      if (!filename || !supportedFile.test(filename) || !downloadUrl) continue;
      const size = await attachmentByteSize(element, downloadUrl);
      const fingerprint = await sha256(`${messageKey}\0${filename}\0${size}\0${downloadUrl}`);
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      attachments.push({
        fingerprint,
        filename,
        contentType: clean(element.getAttribute("data-content-type") || "application/octet-stream"),
        size,
        sourceRef: `alimail:${messageKey}:${fingerprint.slice(0, 16)}`,
        downloadUrl,
      });
    }
    return attachments;
  }

  function apiRequest(requestId, api) {
    return chrome.runtime.sendMessage({ type: "CHEMECAR_ALIMAIL_API_REQUEST", requestId, api })
      .then((response) => {
        if (!response?.ok) throw new Error(response?.message || response?.payload?.error?.message || "赛事资料中心接口未响应。");
        return response.payload;
      });
  }

  function progress(requestId, message, detail = {}) {
    return chrome.runtime.sendMessage({ type: "CHEMECAR_ALIMAIL_SCAN_PROGRESS", requestId, message, ...detail }).catch(() => undefined);
  }

  async function uploadAttachment(requestId, result, source) {
    const response = await fetch(source.downloadUrl, { credentials: "include", cache: "no-store" });
    if (!response.ok) throw new Error(`阿里邮箱附件下载失败（HTTP ${response.status}）。`);
    const blob = await response.blob();
    if (blob.size < 1 || blob.size > 200 * 1024 * 1024) throw new Error("附件实际大小为空或超过 200MB。");
    const created = await apiRequest(requestId, {
      method: "POST",
      path: `/api/media/${result.kind}/multipart/create`,
      json: {
        schoolName: result.schoolName,
        submittedAt: result.submittedAt,
        submissionId: result.submissionId,
        filename: result.filename,
        totalSize: blob.size,
      },
    });
    if (!created.accepted || !created.sessionId) return false;
    const parts = [];
    for (let partNumber = 1, offset = 0; offset < blob.size; partNumber += 1, offset += PART_BYTES) {
      const part = await blob.slice(offset, Math.min(offset + PART_BYTES, blob.size)).arrayBuffer();
      const uploaded = await apiRequest(requestId, {
        method: "PUT",
        path: `/api/media/${result.kind}/multipart/${created.sessionId}/parts/${partNumber}`,
        headers: { "Content-Type": "application/octet-stream", "Content-Length": String(part.byteLength) },
        body: part,
      });
      parts.push({ partNumber: uploaded.partNumber, etag: uploaded.etag });
      await progress(requestId, `正在上传 ${result.schoolName} 的${result.kind === "poster" ? "海报" : "视频"}：${Math.min(100, Math.round((Math.min(offset + PART_BYTES, blob.size) / blob.size) * 100))}%`);
    }
    const completed = await apiRequest(requestId, {
      method: "POST",
      path: `/api/media/${result.kind}/multipart/${created.sessionId}/complete`,
      json: { parts },
    });
    return Boolean(completed.accepted || completed.asset);
  }

  function scrollContainer() {
    const candidates = [...document.querySelectorAll('[role="main"] *, [class*="mail-list"], [class*="mailList"]')]
      .filter((element) => visible(element) && element.scrollHeight > element.clientHeight + 20);
    return candidates.sort((left, right) => right.clientHeight - left.clientHeight)[0] || document.scrollingElement;
  }

  async function scan(message) {
    const requestId = clean(message.requestId);
    const kind = message.kind === "video" ? "video" : "poster";
    const startsAt = clean(message.startsAt);
    const key = mailboxKey();
    const uploadedFingerprints = [];
    const visited = new Set();
    let lastMessageKey = "";
    let reachedBoundary = false;
    try {
      await apiRequest(requestId, {
        method: "POST",
        path: "/api/mail-browser/scans/start",
        json: { scanId: requestId, kind, mailboxKey: key },
      });
      for (let pass = 0; pass < 200 && !reachedBoundary; pass += 1) {
        const rows = candidateRows();
        const records = [];
        const attachmentSources = new Map();
        for (const row of rows) {
          const messageKey = await rowKey(row);
          if (visited.has(messageKey)) continue;
          visited.add(messageKey);
          lastMessageKey = messageKey;
          const receivedAt = rowDate(row);
          if (!receivedAt) continue;
          if (receivedAt.slice(0, 10) < startsAt) {
            reachedBoundary = true;
            break;
          }
          const attachments = await openMessage(row, messageKey);
          for (const attachment of attachments) attachmentSources.set(attachment.fingerprint, attachment);
          records.push({
            messageKey,
            subject: rowSubject(row),
            receivedAt,
            surroundingText: clean(row.textContent || "").slice(0, 2_000),
            attachments: attachments.map((attachment) => {
              const metadata = { ...attachment };
              delete metadata.downloadUrl;
              return metadata;
            }),
          });
          if (records.length >= 10) break;
        }
        if (records.length) {
          const batch = await apiRequest(requestId, {
            method: "POST",
            path: "/api/mail-browser/scans/batch",
            json: { scanId: requestId, kind, mailboxKey: key, messages: records },
          });
          for (const result of batch.results || []) {
            if (result.action !== "upload") continue;
            const source = attachmentSources.get(result.fingerprint);
            if (!source) continue;
            try {
              if (await uploadAttachment(requestId, result, source)) uploadedFingerprints.push(result.fingerprint);
            } catch (error) {
              await progress(requestId, `${result.schoolName || result.filename || "附件"} 暂未收取：${error instanceof Error ? error.message : "下载失败"}`);
            }
          }
          await progress(requestId, `已读取 ${visited.size} 封邮件，已保存 ${uploadedFingerprints.length} 个附件。`, { scanned: visited.size, uploaded: uploadedFingerprints.length });
        }
        if (reachedBoundary) break;
        const scroller = scrollContainer();
        if (!scroller) break;
        const previous = scroller.scrollTop;
        scroller.scrollTop = Math.min(scroller.scrollTop + Math.max(scroller.clientHeight * 0.85, 480), scroller.scrollHeight);
        await delay(700);
        if (scroller.scrollTop === previous) break;
      }
      await apiRequest(requestId, {
        method: "POST",
        path: "/api/mail-browser/scans/finish",
        json: { scanId: requestId, kind, mailboxKey: key, lastMessageKey, uploadedFingerprints },
      });
      await chrome.runtime.sendMessage({
        type: "CHEMECAR_ALIMAIL_SCAN_DONE",
        requestId,
        kind,
        scanned: visited.size,
        uploaded: uploadedFingerprints.length,
        reachedBoundary,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "阿里邮箱扫描失败。";
      await apiRequest(requestId, {
        method: "POST",
        path: "/api/mail-browser/scans/finish",
        json: { scanId: requestId, kind, mailboxKey: key, lastMessageKey, uploadedFingerprints, error: errorMessage },
      }).catch(() => undefined);
      await chrome.runtime.sendMessage({ type: "CHEMECAR_ALIMAIL_SCAN_ERROR", requestId, kind, message: errorMessage }).catch(() => undefined);
    } finally {
      running = false;
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "CHEMECAR_ALIMAIL_COLLECTOR_PROBE") {
      sendResponse({ ready: true, state: pageState(), mailboxKey: mailboxKey() });
      return undefined;
    }
    if (message?.type === "CHEMECAR_ALIMAIL_SCAN_START") {
      if (running) {
        sendResponse({ accepted: false, message: "阿里邮箱媒体扫描正在执行，请稍候。" });
        return undefined;
      }
      if (pageState() === collectorState.loggedOut) {
        sendResponse({ accepted: false, message: "阿里邮箱尚未登录，请先登录后重试。" });
        return undefined;
      }
      if (pageState() !== collectorState.inboxReady) {
        sendResponse({ accepted: false, message: "阿里邮箱收件箱尚未准备好，请稍后重试。" });
        return undefined;
      }
      running = true;
      sendResponse({ accepted: true });
      void scan(message);
      return undefined;
    }
    return undefined;
  });
})();
