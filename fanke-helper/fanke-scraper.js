/* global chrome */
(() => {
  if (globalThis.__CHEMECAR_FANKE_SCRAPER_LOADED__) return;
  globalThis.__CHEMECAR_FANKE_SCRAPER_LOADED__ = true;
  let running = false;
  const trustedHost = (hostname) => /^download\.s\d+i\.co99\.net$/i.test(hostname)
    || /(?:^|\.)faiusr\.com$/i.test(hostname)
    || /(?:^|\.)fkw\.com$/i.test(hostname);

  const clean = (value) => String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();

  const supportedExtension = /\.(?:xlsx|zip|7z|rar|ai|jpe?g|mp4)$/i;

  function fileIconExtension(element) {
    const className = clean(`${element?.className || ""} ${element?.querySelector?.("[class*='file-icon--']")?.getAttribute?.("class") || ""}`);
    if (/file-icon--(?:exls|xlsx?|excel)/i.test(className)) return "xlsx";
    if (/file-icon--(?:gzip|zip|archive|rar|7z)/i.test(className)) return "zip";
    if (/file-icon--(?:mp4|video)/i.test(className)) return "mp4";
    if (/file-icon--ai(?:\s|$)/i.test(className)) return "ai";
    if (/file-icon--(?:jpe?g|image|img|picture)/i.test(className)) return "jpg";
    return "";
  }

  function isPreviewImage(value) {
    try {
      const url = new URL(value, location.href);
      if (/!\d{2,4}x\d{2,4}\.(?:jpe?g|png|gif|webp)$/i.test(url.pathname)) return true;
      const width = Number(url.searchParams.get("w") || url.searchParams.get("width"));
      const height = Number(url.searchParams.get("h") || url.searchParams.get("height"));
      return /\.(?:jpe?g|png|gif|webp)$/i.test(url.pathname)
        && ((Number.isFinite(width) && width > 0 && width <= 320) || (Number.isFinite(height) && height > 0 && height <= 320));
    } catch {
      return false;
    }
  }

  function normalizedUrl(value, base = location.href) {
    if (!value) return null;
    try {
      const decoded = String(value).replace(/&amp;/g, "&");
      const url = new URL(decoded, base);
      return url.protocol === "https:" && trustedHost(url.hostname) ? url.href : null;
    } catch {
      return null;
    }
  }

  function filenameFromUrl(value) {
    try {
      const url = new URL(value);
      const queryName = url.searchParams.get("f") || url.searchParams.get("filename") || url.searchParams.get("name");
      return clean(queryName ? decodeURIComponent(queryName) : decodeURIComponent(url.pathname.split("/").pop() || ""));
    } catch {
      return "";
    }
  }

  function byteSizeFromText(text) {
    const match = clean(text).match(/文件大小\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(GB|MB|KB|B)/i);
    if (!match) return null;
    const unit = match[2].toUpperCase();
    const multiplier = unit === "GB" ? 1024 ** 3 : unit === "MB" ? 1024 ** 2 : unit === "KB" ? 1024 : 1;
    const bytes = Math.round(Number(match[1]) * multiplier);
    return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
  }

  async function resolveViewFile(file) {
    const viewUrl = new URL(file.downloadUrl);
    if (!/\/view\.jsp$/i.test(viewUrl.pathname) || !viewUrl.searchParams.get("fileID")) return file;
    const response = await fetch(viewUrl.href, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      redirect: "follow",
    });
    if (!response.ok) throw new Error(`凡科附件信息页返回 HTTP ${response.status}`);
    const finalUrl = normalizedUrl(response.url, viewUrl.href);
    if (finalUrl && !/\/view\.jsp(?:\?|$)/i.test(finalUrl)) {
      await response.body?.cancel().catch(() => undefined);
      return { ...file, filename: filenameFromUrl(finalUrl) || file.filename, downloadUrl: finalUrl };
    }
    const html = await response.text();
    const documentView = new DOMParser().parseFromString(html, "text/html");
    const directCandidates = [...documentView.querySelectorAll("a[href]")]
      .map((anchor) => normalizedUrl(anchor.getAttribute("href"), response.url || viewUrl.href))
      .filter(Boolean)
      .filter((value) => /^https:\/\/download\.s\d+i\.co99\.net\//i.test(value));
    if (!directCandidates.length) {
      const decodedHtml = html.replace(/&amp;/g, "&").replace(/\\\//g, "/");
      const embedded = decodedHtml.match(/https:\/\/download\.s\d+i\.co99\.net\/[A-Za-z0-9%._~:/?#[\]@!$&'()*+,;=-]+/ig) || [];
      for (const candidate of embedded) {
        const normalized = normalizedUrl(candidate, response.url || viewUrl.href);
        if (normalized) directCandidates.push(normalized);
      }
    }
    const downloadUrl = directCandidates[0];
    if (!downloadUrl) throw new Error(`附件“${file.filename}”未找到原始下载地址`);
    const pageText = clean(documentView.body?.textContent || "");
    const textFilename = pageText.match(/文件名称\s*[:：]?\s*([^\s]+\.(?:xlsx|zip|7z|rar|ai|jpe?g|mp4))/i)?.[1] || "";
    const filename = supportedExtension.test(textFilename)
      ? clean(textFilename)
      : filenameFromUrl(downloadUrl) || file.filename;
    return { ...file, filename, downloadUrl, size: byteSizeFromText(pageText) || file.size };
  }

  function headerCells() {
    const header = document.querySelector(".jz-table-header, .jz-table-head, thead tr, [class*='tableHeader']");
    if (!header) return [];
    // Keep the empty checkbox column. Removing it shifts every following
    // heading one place to the left and mixes the ID into the school name.
    const direct = [...header.children].map((cell) => clean(cell.textContent));
    return direct.length >= 2 ? direct : [...header.querySelectorAll("th,td,[class*='cell'],[class*='Cell']")].map((cell) => clean(cell.textContent)).filter(Boolean);
  }

  function dataRows() {
    const selectors = [
      ".jz-table-body .jz-table-row",
      "li.jz-table-row:not(.jz-table-header)",
      "tbody tr",
      "[class*='tableBody'] [class*='tableRow']",
    ];
    for (const selector of selectors) {
      const rows = [...document.querySelectorAll(selector)].filter((row) => /\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(clean(row.textContent)));
      if (rows.length) return rows;
    }
    return [];
  }

  function rowCells(row) {
    const layout = row.querySelector(":scope > .dd-handle, :scope > [class*='row-layout'], :scope > [class*='RowLayout']") || row;
    const direct = [...layout.children].filter((cell) => clean(cell.textContent) || cell.querySelector("a,[data-url],[data-href]"));
    return direct.length ? direct : [...row.querySelectorAll("td,[class*='cell'],[class*='Cell']")];
  }

  function findFiles(root, headers, cells) {
    const found = new Map();
    const remember = (value, element, context) => {
      const href = normalizedUrl(value);
      if (!href || isPreviewImage(href) || element?.tagName === "IMG") return;
      const parsed = new URL(href);
      const viewFileId = /\/view\.jsp$/i.test(parsed.pathname) ? clean(parsed.searchParams.get("fileID")) : "";
      const textName = clean(element?.getAttribute?.("download") || element?.getAttribute?.("title") || element?.textContent);
      const iconExtension = fileIconExtension(element);
      const filename = supportedExtension.test(textName)
        ? textName
        : viewFileId && iconExtension
          ? `凡科文件-${viewFileId}.${iconExtension}`
          : filenameFromUrl(href);
      if (!filename || !supportedExtension.test(filename)) return;
      const fileId = viewFileId || clean(element?.dataset?.fileId || element?.getAttribute?.("data-file-id")) || null;
      const rawSize = element?.dataset?.fileSize || element?.getAttribute?.("data-file-size");
      const sizeValue = rawSize === null || rawSize === undefined || rawSize === "" ? Number.NaN : Number(rawSize);
      found.set(`${fileId || ""}\0${href}`, {
        fileId,
        filename,
        downloadUrl: href,
        size: Number.isSafeInteger(sizeValue) && sizeValue > 0 ? sizeValue : null,
        fieldLabel: clean(context),
      });
    };
    for (const element of root.querySelectorAll("a[href],[download],[data-url],[data-href],[data-download-url],[data-file-url],[data-file-id],[onclick]")) {
      const cell = element.closest("td,.jz-table-td,[class*='TableTd']");
      const cellIndex = cell && cells.includes(cell) ? cells.indexOf(cell) : -1;
      const context = [cellIndex >= 0 ? headers[cellIndex] : "", element.getAttribute("title"), element.getAttribute("aria-label")].filter(Boolean).join(" ");
      const attributes = [...element.attributes].filter((attribute) => /^(?:href|download|onclick|data-(?:.*file.*|.*download.*|.*url.*))$/i.test(attribute.name));
      for (const attribute of attributes) {
        const raw = attribute.value;
        if (!raw) continue;
        const matches = raw.match(/https?:\\?\/\\?\/[A-Za-z0-9%._~:/?#[\]@!$&'()*+,;=\\-]+/g) || [raw];
        for (const match of matches) remember(match.replace(/\\\//g, "/"), element, context);
      }
    }
    return [...found.values()];
  }

  function dateValue(text) {
    const match = text.match(/(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!match) return null;
    const [, year, month, day, hour, minute, second = "00"] = match;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${hour.padStart(2, "0")}:${minute}:${second}+08:00`;
  }

  const dateOnly = (submittedAt) => typeof submittedAt === "string" ? submittedAt.slice(0, 10) : "";

  async function resolveRecordFiles(record) {
    const files = [];
    const errors = [];
    for (const file of record.files) {
      try {
        files.push(await resolveViewFile(file));
      } catch (error) {
        errors.push(error instanceof Error ? error.message : `附件“${file.filename}”解析失败`);
      }
    }
    return { ...record, files, fileResolutionErrors: errors };
  }

  function schoolValue(text) {
    const normalized = clean(text).replace(/^\d{1,4}(?=[\u3400-\u9fffA-Za-z])/u, "");
    const match = normalized.match(/([\u3400-\u9fffA-Za-z][\u3400-\u9fffA-Za-z0-9·＆&()（） -]{1,100}?(?:大学|学院|职业技术学院|研究院|学校|中学))/);
    return match ? clean(match[1]) : "";
  }

  function recordFromRow(row, headers) {
    const cells = rowCells(row);
    const values = cells.map((cell) => clean(cell.textContent));
    const byHeader = (pattern) => {
      const index = headers.findIndex((header) => pattern.test(header));
      return index >= 0 ? values[index] || "" : "";
    };
    const text = clean(row.textContent);
    const submittedAt = dateValue(byHeader(/提交时间|提交日期|时间/) || text);
    const schoolName = schoolValue(byHeader(/学校|院校|单位|团队|队伍/)) || schoolValue(text);
    const visibleId = byHeader(/^(?:ID|编号|提交编号)$/i);
    const linkId = [...row.querySelectorAll("a[href],[data-record-id],[data-submit-id]")].map((element) => {
      const raw = element.getAttribute("data-record-id") || element.getAttribute("data-submit-id") || element.getAttribute("href") || "";
      const match = raw.match(/(?:submit(?:Id)?|recordId|resultId)=([A-Za-z0-9_-]{2,100})/i);
      return match?.[1] || "";
    }).find(Boolean) || "";
    const submissionId = clean(linkId || visibleId || `record-${schoolName}-${submittedAt || ""}`);
    if (!submissionId || !submittedAt || !schoolName) return null;
    return { submissionId, submittedAt, schoolName, files: findFiles(row, headers, cells) };
  }

  const resultActionSelectors = "a,button,[role='button'],[onclick],[data-href],[data-url]";

  function resultActions() {
    return [...document.querySelectorAll(resultActionSelectors)].filter((element) => {
      const label = clean(`${element.textContent || ""} ${element.getAttribute?.("title") || ""} ${element.getAttribute?.("aria-label") || ""}`);
      return /查看结果|查看提交|提交结果|表单结果/.test(label);
    });
  }

  function containsIdentifier(value, identifier) {
    if (!identifier) return false;
    const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[\\s=:/?&#_'"-])${escaped}(?:$|[\\s&?#_'"-])`, "i").test(clean(value));
  }

  function findResultAction(formId) {
    const actions = resultActions();
    const scored = actions.map((element) => {
      const attributes = ["href", "onclick", "data-href", "data-url", "data-form-id", "data-id"]
        .map((name) => element.getAttribute?.(name) || "")
        .join(" ");
      const row = element.closest?.("tr,li,[class*='row'],[class*='item'],[class*='form']");
      const rowText = clean(row?.textContent || "");
      const label = clean(`${element.textContent || ""} ${element.getAttribute?.("title") || ""} ${element.getAttribute?.("aria-label") || ""}`);
      const score = (containsIdentifier(attributes, formId) ? 100 : 0)
        + (containsIdentifier(rowText, formId) ? 60 : 0)
        + (/^查看结果$/.test(label) ? 10 : 0);
      return { element, score };
    }).sort((left, right) => right.score - left.score);
    if (!scored.length) return null;
    if (scored[0].score >= 60 || scored.length === 1) return scored[0].element;
    return null;
  }

  function managerPageReady() {
    return resultActions().length > 0 || /manageFrameFormManage/i.test(location.href);
  }

  function nextPageButton() {
    const candidates = [...document.querySelectorAll("button,a,li,[role='button']")];
    return candidates.find((element) => {
      const label = clean(`${element.textContent} ${element.getAttribute("title") || ""} ${element.getAttribute("aria-label") || ""}`);
      const className = String(element.className || "");
      const next = /下一页|下页|next/i.test(label) || /(?:^|[-_])next(?:$|[-_])/i.test(className);
      const disabled = element.matches(":disabled,[aria-disabled='true']") || /disabled|disable/.test(className);
      return next && !disabled;
    }) || null;
  }

  const pageSignature = () => dataRows().slice(0, 3).map((row) => clean(row.textContent)).join("|");
  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  async function waitForValue(read, timeout = 15_000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const value = read();
      if (value) return value;
      await delay(120);
    }
    return null;
  }

  async function waitForPageChange(previous) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await delay(150);
      const current = pageSignature();
      if (current && current !== previous) return true;
    }
    return false;
  }

  function paginationContainers() {
    const containers = [];
    const seen = new Set();
    for (const selector of [
      ".jz-pagination",
      "[class*='pagination']",
      "[class*='Pagination']",
      "[class*='pager']",
      "[class*='Pager']",
      "[aria-label*='分页']",
    ]) {
      for (const element of document.querySelectorAll(selector)) {
        if (!seen.has(element)) {
          seen.add(element);
          containers.push(element);
        }
      }
    }
    return containers;
  }

  function disabledControl(element) {
    const className = String(element.className || "");
    return element.matches?.(":disabled,[aria-disabled='true']") || /disabled|disable/i.test(className);
  }

  function currentPageControl(element) {
    const className = String(element.className || "");
    return element.getAttribute?.("aria-current") === "page" || /(?:^|[-_\s])(active|current|selected)(?:$|[-_\s])/i.test(className);
  }

  async function resetToFirstPage() {
    const containers = paginationContainers();
    if (!containers.length) return true;
    for (const container of containers) {
      const controls = [...container.querySelectorAll("button,a,li,[role='button']")].filter((element) => !disabledControl(element));
      const first = controls.find((element) => clean(element.textContent) === "1");
      if (!first) continue;
      const active = controls.find(currentPageControl);
      if (active === first || (active && clean(active.textContent) === "1")) return true;
      const previous = pageSignature();
      first.scrollIntoView?.({ block: "center" });
      first.click();
      if (await waitForPageChange(previous) || currentPageControl(first)) return true;
      return false;
    }
    return true;
  }

  async function collect(requestId, formId, startsAt, targetKind) {
    let pages = 0;
    let records = 0;
    const seenPages = new Set();
    const targetLabel = targetKind === "registration" ? "报名表" : "EDP";
    try {
      for (let page = 1; page <= 200; page += 1) {
        const rows = dataRows();
        if (!rows.length) throw new Error("当前页面没有可识别的表单记录。请在凡科后台打开该表单的“查看结果”页面后重试。");
        const signature = pageSignature();
        if (seenPages.has(signature)) break;
        seenPages.add(signature);
        const headers = headerCells();
        const parsed = rows.map((row) => recordFromRow(row, headers)).filter(Boolean);
        const eligible = parsed.filter((record) => dateOnly(record.submittedAt) >= startsAt);
        const reachedDateBoundary = parsed.some((record) => dateOnly(record.submittedAt) < startsAt);
        const batch = [];
        for (const record of eligible) batch.push(await resolveRecordFiles(record));
        pages += 1;
        records += batch.length;
        await chrome.runtime.sendMessage({ type: "FANKE_HELPER_PROGRESS", requestId, page: pages, records, targetKind, message: `正在核对 ${startsAt} 及之后的${targetLabel}：第 ${pages} 页，已读取 ${records} 条候选记录。` });
        if (batch.length) await chrome.runtime.sendMessage({ type: "FANKE_HELPER_RECORDS", requestId, formId, targetKind, records: batch });
        if (reachedDateBoundary) break;
        const next = nextPageButton();
        if (!next) break;
        next.scrollIntoView({ block: "center" });
        next.click();
        if (!await waitForPageChange(signature)) break;
      }
      await chrome.runtime.sendMessage({ type: "FANKE_HELPER_DONE", requestId, formId, targetKind, pages, records });
    } catch (error) {
      await chrome.runtime.sendMessage({ type: "FANKE_HELPER_ERROR", requestId, message: error instanceof Error ? error.message : "凡科页面读取失败。" }).catch(() => undefined);
    } finally {
      running = false;
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "FANKE_HELPER_PROBE") {
      sendResponse({ ready: dataRows().length > 0, manager: managerPageReady() });
      return undefined;
    }
    if (message?.type === "FANKE_HELPER_OPEN_RESULTS") {
      (async () => {
        const action = await waitForValue(() => findResultAction(clean(message.formId)));
        if (!action) {
          sendResponse({ accepted: false, message: `凡科表单管理页没有找到编号为 ${clean(message.formId) || "当前"} 的“查看结果”入口。` });
          return;
        }
        action.scrollIntoView?.({ block: "center" });
        action.click();
        sendResponse({ accepted: true });
      })();
      return true;
    }
    if (message?.type === "FANKE_HELPER_PREPARE") {
      (async () => {
        if (!dataRows().length) {
          sendResponse({ accepted: false, message: "凡科结果清单尚未加载完成。" });
          return;
        }
        const reset = await resetToFirstPage();
        sendResponse(reset
          ? { accepted: true, page: 1 }
          : { accepted: false, message: "凡科结果页未能自动返回第一页，请稍后重试。" });
      })();
      return true;
    }
    if (message?.type === "FANKE_HELPER_COLLECT") {
      if (running) {
        sendResponse({ accepted: false, message: "凡科采集助手正在执行上一项任务，请稍候。" });
        return undefined;
      }
      if (typeof message.startsAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(message.startsAt)) {
        sendResponse({ accepted: false, message: "请先在赛事资料中心当前栏目设置收集起始日期。" });
        return undefined;
      }
      if (!["registration", "edp"].includes(message.targetKind)) {
        sendResponse({ accepted: false, message: "凡科只采集报名表和 EDP；海报和视频请使用阿里邮箱采集。" });
        return undefined;
      }
      running = true;
      sendResponse({ accepted: true });
      void collect(message.requestId, message.formId, message.startsAt, message.targetKind);
      return undefined;
    }
    return undefined;
  });
})();
