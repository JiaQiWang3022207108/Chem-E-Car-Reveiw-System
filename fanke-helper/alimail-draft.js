/* global chrome */
(() => {
  if (globalThis.__CHEMECAR_ALIMAIL_DRAFT_LOADED__) return;
  globalThis.__CHEMECAR_ALIMAIL_DRAFT_LOADED__ = true;
  const MAX_DRAFTS_PER_BATCH = 25;
  const FIELD_VERIFY_TIMEOUT = 6_000;

  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  function visible(element) {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function descriptor(element) {
    const labelledBy = (element.getAttribute("aria-labelledby") || "").split(/\s+/u)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent || "")
      .join(" ");
    const labels = "labels" in element && element.labels
      ? Array.from(element.labels).map((label) => label.textContent || "").join(" ")
      : "";
    return [
      element.getAttribute("aria-label"),
      labelledBy,
      labels,
      element.getAttribute("placeholder"),
      element.getAttribute("title"),
      element.getAttribute("name"),
      element.id,
      element.className,
    ].filter((value) => typeof value === "string").join(" ").normalize("NFKC").toLocaleLowerCase("zh-CN");
  }

  function readableValue(element) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value;
    return element.innerText || element.textContent || "";
  }

  function editableTarget(element) {
    if (!(element instanceof Element)) return null;
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable) return element;
    const descendant = element.querySelector("input:not([type='hidden']), textarea, [contenteditable='true']");
    return descendant || null;
  }

  function fieldSurfaceVisible(element) {
    let current = element;
    for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) {
      if (visible(current)) return true;
    }
    return false;
  }

  function compactSemanticText(value) {
    return normalizedText(value).replace(/\s+/gu, "").toLocaleLowerCase("zh-CN");
  }

  function usableEditable(element) {
    return element instanceof Element
      && !element.hasAttribute("disabled")
      && !element.hasAttribute("readonly")
      && fieldSurfaceVisible(element);
  }

  function editableCandidatesWithin(container) {
    const candidates = [];
    const seen = new Set();
    const add = (element) => {
      const target = editableTarget(element);
      if (!target || seen.has(target) || !usableEditable(target)) return;
      seen.add(target);
      candidates.push(target);
    };
    if (container.matches?.("input:not([type='hidden']), textarea, [contenteditable='true'], [role='textbox'], [role='combobox']")) add(container);
    for (const element of container.querySelectorAll?.("input:not([type='hidden']), textarea, [contenteditable='true'], [role='textbox'], [role='combobox']") || []) add(element);
    return candidates;
  }

  function fieldVerticalDistance(field, label) {
    const labelRect = label.getBoundingClientRect();
    let current = field;
    for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
      const rect = current.getBoundingClientRect();
      const style = getComputedStyle(current);
      if (style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0 && rect.height < 120) {
        return Math.abs((rect.top + rect.bottom) / 2 - (labelRect.top + labelRect.bottom) / 2);
      }
    }
    return Number.MAX_SAFE_INTEGER;
  }

  function findFieldFromTextLabel(kind) {
    const expected = kind === "recipient" ? "收件人" : "主题";
    const labels = Array.from(document.querySelectorAll("label, span, div, p, td, th"))
      .filter((element) => visible(element) && compactSemanticText(element.textContent || "") === expected);
    for (const label of labels) {
      let row = label.parentElement;
      for (let depth = 0; row && depth < 5; depth += 1, row = row.parentElement) {
        const candidates = editableCandidatesWithin(row)
          .filter((candidate) => kind !== "subject" || candidate.getBoundingClientRect().height < 120)
          .sort((left, right) => fieldVerticalDistance(left, label) - fieldVerticalDistance(right, label));
        if (candidates.length) return candidates[0];
      }
    }
    return null;
  }

  function findAliMailField(kind) {
    const aliases = kind === "recipient"
      ? { chinese: "收件人", english: /recipient|\bto\b/iu, role: "combobox" }
      : { chinese: "主题", english: /subject/iu, role: "textbox" };
    const selectors = [
      `[role='${aliases.role}'][aria-label='${aliases.chinese}']`,
      `[role='${aliases.role}'][aria-label*='${aliases.chinese}']`,
      `input[aria-label='${aliases.chinese}']`,
      `textarea[aria-label='${aliases.chinese}']`,
      `[contenteditable='true'][aria-label='${aliases.chinese}']`,
      `input[placeholder*='${aliases.chinese}']`,
      `textarea[placeholder*='${aliases.chinese}']`,
    ];
    const exactMatches = [];
    for (const selector of selectors) {
      for (const candidate of document.querySelectorAll(selector)) {
        const target = editableTarget(candidate);
        // AliMail collapses the empty recipient input to zero width until it is focused.
        // The labelled combobox remains visible, so accept its editable descendant here.
        if (target && fieldSurfaceVisible(candidate) && !target.hasAttribute("disabled") && !target.hasAttribute("readonly")) exactMatches.push(target);
      }
    }
    if (exactMatches.length) return exactMatches.at(-1);

    const candidates = Array.from(document.querySelectorAll("input:not([type='hidden']), textarea, [contenteditable='true']"));
    const semanticMatches = candidates.filter((candidate) => {
      const description = descriptor(candidate);
      return usableEditable(candidate)
        && (compactSemanticText(description).includes(aliases.chinese) || aliases.english.test(description));
    });
    return semanticMatches.at(-1) || findFieldFromTextLabel(kind);
  }

  function findClickable(patterns) {
    const candidates = document.querySelectorAll("button, a, [role='button'], [title]");
    let partial = null;
    for (const element of candidates) {
      if (!visible(element) || element.getAttribute("aria-disabled") === "true") continue;
      const text = `${element.textContent || ""} ${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""}`
        .normalize("NFKC").replace(/\s+/gu, " ").trim();
      if (patterns.some((pattern) => pattern.exact.test(text))) return element;
      if (!partial && patterns.some((pattern) => pattern.partial.test(text))) partial = element;
    }
    return partial;
  }

  async function waitFor(read, timeout = 12_000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const value = read();
      if (value) return value;
      await delay(120);
    }
    return null;
  }

  function emitFieldEvents(element, value) {
    const realm = element.ownerDocument.defaultView || window;
    element.dispatchEvent(new realm.InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: value }));
    element.dispatchEvent(new realm.Event("change", { bubbles: true, composed: true }));
  }

  function setNativeValue(element, value) {
    element.focus();
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(element, value);
      else element.value = value;
    } else {
      const owner = element.ownerDocument;
      const selection = owner.getSelection?.();
      if (selection) {
        const range = owner.createRange();
        range.selectNodeContents(element);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      const inserted = typeof owner.execCommand === "function" && owner.execCommand("insertText", false, value);
      if (!inserted) element.replaceChildren(owner.createTextNode(value));
    }
    emitFieldEvents(element, value);
  }

  function findBodyEditor(excluded) {
    for (const frame of document.querySelectorAll("iframe")) {
      if (!visible(frame)) continue;
      try {
        const body = frame.contentDocument?.body;
        if (body && (body.isContentEditable || frame.contentDocument?.designMode === "on")) return body;
      } catch {
        // Cross-origin frames are never valid editable message bodies here.
      }
    }
    let selected = null;
    let selectedArea = -1;
    for (const element of document.querySelectorAll("[contenteditable='true']")) {
      if (!visible(element) || excluded.has(element)) continue;
      const rect = element.getBoundingClientRect();
      const description = descriptor(element);
      const area = rect.width * rect.height + (/正文|body|editor|compose|content/iu.test(description) ? 1_000_000 : 0);
      if (area > selectedArea) {
        selected = element;
        selectedArea = area;
      }
    }
    return selected;
  }

  function normalizedText(value) {
    return String(value || "")
      .normalize("NFKC")
      .replace(/\u200b|\u200c|\u200d|\ufeff/gu, "")
      .replace(/\u00a0/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
  }

  function recipientRegionText(field) {
    const parts = [];
    let current = field;
    for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
      if (current !== field) parts.push(current.textContent || "");
      for (const labelled of current.querySelectorAll?.("[aria-label], [title], [data-email]") || []) {
        if (labelled === field) continue;
        parts.push(labelled.getAttribute("aria-label") || "", labelled.getAttribute("title") || "", labelled.getAttribute("data-email") || "");
      }
    }
    return normalizedText(parts.join(" ")).toLocaleLowerCase("en-US");
  }

  function dispatchEnter(element) {
    const realm = element.ownerDocument.defaultView || window;
    for (const type of ["keydown", "keypress", "keyup"]) {
      const event = new realm.KeyboardEvent(type, { key: "Enter", code: "Enter", bubbles: true, composed: true, cancelable: true });
      element.dispatchEvent(event);
    }
  }

  async function fillRecipient(field, email, subjectField) {
    const expectedEmail = email.toLocaleLowerCase("en-US");
    const initialRegion = recipientRegionText(field);
    setNativeValue(field, email);
    const copied = await waitFor(() => normalizedText(readableValue(field)).toLocaleLowerCase("en-US") === expectedEmail, 2_000);
    if (!copied) throw new Error("阿里邮箱没有写入收件人地址，本次没有保存。助手会重新识别写信页，请稍后重试。");
    dispatchEnter(field);
    subjectField.focus();
    field.blur();
    const committed = await waitFor(() => {
      if (!field.isConnected) return true;
      const currentValue = normalizedText(readableValue(field)).toLocaleLowerCase("en-US");
      const currentRegion = recipientRegionText(field);
      return currentValue === expectedEmail
        || currentRegion.includes(expectedEmail)
        || (currentValue === "" && currentRegion !== initialRegion && currentRegion.length > initialRegion.length);
    }, FIELD_VERIFY_TIMEOUT);
    if (!committed) {
      throw new Error("阿里邮箱没有保留收件人地址或生成联系人标签，本次没有保存。助手会重新识别写信页，请稍后重试。");
    }
    return true;
  }

  async function fillAndVerifyField(field, value, label) {
    setNativeValue(field, value);
    field.blur();
    const expected = normalizedText(value);
    const verified = await waitFor(() => normalizedText(readableValue(field)) === expected, FIELD_VERIFY_TIMEOUT);
    if (!verified) throw new Error(`阿里邮箱没有写入${label}。为防止生成空草稿，本次没有保存；助手会重新识别写信页，请稍后重试。`);
  }

  function findComposeFields() {
    const recipient = findAliMailField("recipient");
    const subject = findAliMailField("subject");
    return recipient && subject && recipient !== subject ? { recipient, subject } : null;
  }

  function currentBodyText(recipient, subject) {
    const body = findBodyEditor(new Set([recipient, subject]));
    return body ? normalizedText(readableValue(body)) : "";
  }

  async function waitForStableBlankComposer(timeout = 12_000) {
    let previousRecipient = null;
    let previousSubject = null;
    let stableSince = 0;
    return waitFor(() => {
      const fields = findComposeFields();
      const blank = fields
        && fields.recipient.isConnected
        && fields.subject.isConnected
        && !normalizedText(readableValue(fields.recipient))
        && !normalizedText(readableValue(fields.subject))
        && !currentBodyText(fields.recipient, fields.subject);
      if (!blank) {
        previousRecipient = null;
        previousSubject = null;
        stableSince = 0;
        return null;
      }
      if (fields.recipient !== previousRecipient || fields.subject !== previousSubject) {
        previousRecipient = fields.recipient;
        previousSubject = fields.subject;
        stableSince = Date.now();
        return null;
      }
      return Date.now() - stableSince >= 450 ? fields : null;
    }, timeout);
  }

  function draftStatusText() {
    const matches = Array.from(document.querySelectorAll("body *"))
      .filter((element) => visible(element) && /草稿保存于/u.test(element.textContent || ""))
      .map((element) => normalizedText(element.textContent || ""))
      .filter((text) => /^草稿保存于/u.test(text))
      .sort((left, right) => left.length - right.length);
    return matches[0] || "";
  }

  async function openComposer() {
    const existing = findComposeFields();
    if (existing
      && !normalizedText(readableValue(existing.recipient))
      && !normalizedText(readableValue(existing.subject))
      && !currentBodyText(existing.recipient, existing.subject)) {
      const stableExisting = await waitForStableBlankComposer(2_000);
      if (stableExisting) return stableExisting;
    }
    const compose = findClickable([
      { exact: /^写邮件$/u, partial: /写邮件/u },
      { exact: /^写信$/u, partial: /新建邮件|撰写邮件/u },
    ]);
    if (!compose) throw new Error("未找到阿里邮箱的“写邮件”按钮。请确认已经登录新版阿里邮箱；助手会自动打开写信页，不需要手动刷新。");
    compose.click();
    const fields = await waitForStableBlankComposer();
    if (!fields) {
      const recipient = findAliMailField("recipient");
      const subject = findAliMailField("subject");
      const missing = [!recipient && "收件人", !subject && "邮件主题"].filter(Boolean).join("和");
      const reason = recipient && subject && recipient === subject ? "收件人与邮件主题未能区分" : `未识别到${missing || "收件人或邮件主题"}`;
      throw new Error(`写信窗口已打开，但${reason}输入框。请确认助手为 v${chrome.runtime.getManifest().version}，稍后重试；不需要手动刷新邮箱页面。`);
    }
    return fields;
  }

  async function openComposerAutomatically() {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await openComposer();
      } catch (error) {
        lastError = error;
        if (attempt === 0) await delay(1_200);
      }
    }
    const reason = lastError instanceof Error ? lastError.message : "无法打开新的写信页。";
    throw new Error(`助手自动切换写信页并重试后仍失败：${reason}`);
  }

  async function fillDraft(draft, index, total) {
    const { recipient, subject } = await openComposerAutomatically();
    const initialSaveStatus = draftStatusText();
    const recipientCommitted = await fillRecipient(recipient, draft.recipient, subject);
    await fillAndVerifyField(subject, draft.subject, "邮件主题");
    const body = await waitFor(() => findBodyEditor(new Set([recipient, subject])));
    if (!body) throw new Error("未识别到邮件正文编辑框。助手会重新打开并识别写信页，请稍后重试。");
    await fillAndVerifyField(body, draft.body, "邮件正文");

    const verification = {
      recipient: recipientCommitted,
      subject: normalizedText(readableValue(subject)) === normalizedText(draft.subject),
      body: normalizedText(readableValue(body)) === normalizedText(draft.body),
    };
    const missing = Object.entries(verification).filter(([, ok]) => !ok).map(([field]) => ({ recipient: "收件人", subject: "邮件主题", body: "邮件正文" })[field]);
    if (missing.length) throw new Error(`阿里邮箱未能回读确认${missing.join("、")}。为防止生成空草稿，本次没有保存。`);

    const save = findClickable([
      { exact: /^存草稿$/u, partial: /存草稿/u },
      { exact: /^保存草稿$/u, partial: /保存.*草稿/u },
    ]);
    if (!save) {
      throw new Error(`${total === 1 ? "这封" : `第 ${index + 1} 封`}回执已填入写信窗口，但未找到“存草稿”按钮，因此没有报告成功。请手动保存后重试。`);
    }
    save.click();
    const saveConfirmed = await waitFor(() => {
      const currentStatus = draftStatusText();
      if (currentStatus && currentStatus !== initialSaveStatus) return true;
      return !visible(recipient) || !visible(subject);
    }, 8_000);
    if (!saveConfirmed) {
      throw new Error(`${total === 1 ? "这封" : `第 ${index + 1} 封`}回执的收件人、主题和正文已经填入，但阿里邮箱没有确认保存，因此没有报告成功。请先手动保存后再继续。`);
    }
    return { saved: true, leftOpen: false };
  }

  function validatedDrafts(value) {
    if (!Array.isArray(value) || value.length < 1 || value.length > MAX_DRAFTS_PER_BATCH) {
      throw new Error(`每批只能创建 1 至 ${MAX_DRAFTS_PER_BATCH} 封草稿。`);
    }
    return value.map((draft) => {
      const schoolName = typeof draft?.schoolName === "string" ? draft.schoolName.normalize("NFKC").trim() : "";
      const recipient = typeof draft?.recipient === "string" ? draft.recipient.normalize("NFKC").trim() : "";
      const subject = typeof draft?.subject === "string" ? draft.subject.normalize("NFKC").trim() : "";
      const body = typeof draft?.body === "string" ? draft.body.normalize("NFKC").trim() : "";
      if (!schoolName) throw new Error("回执缺少学校名称，未写入草稿。");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(recipient)) throw new Error("回执缺少有效的收件人邮箱，未写入草稿。");
      if (!subject || subject.length > 300) throw new Error("回执邮件主题为空或过长，未写入草稿。");
      if (!body || body.length > 30_000) throw new Error("回执邮件正文为空或过长，未写入草稿。");
      return { schoolName, recipient, subject, body };
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "CHEMECAR_ALIMAIL_PROBE") {
      sendResponse({ ready: true, composer: Boolean(findComposeFields()) });
      return undefined;
    }
    if (message?.type !== "CHEMECAR_ALIMAIL_FILL_DRAFTS") return undefined;
    (async () => {
      const drafts = validatedDrafts(message.drafts);
      let saved = 0;
      let leftOpen = 0;
      for (let index = 0; index < drafts.length; index += 1) {
        const draft = drafts[index];
        try {
          const result = await fillDraft(draft, index, drafts.length);
          if (result.saved) saved += 1;
          if (result.leftOpen) leftOpen += 1;
          if (index + 1 < drafts.length) {
            await delay(1_000);
            await openComposerAutomatically();
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : "阿里邮箱草稿写入失败。";
          throw new Error(`${draft.schoolName}回执写入失败：${reason}${saved ? ` 此批此前已成功保存 ${saved} 封。` : ""}`);
        }
      }
      sendResponse({ ok: true, created: saved + leftOpen, saved, leftOpen });
    })().catch((error) => sendResponse({ ok: false, message: error instanceof Error ? error.message : "阿里邮箱草稿写入失败。" }));
    return true;
  });
})();
