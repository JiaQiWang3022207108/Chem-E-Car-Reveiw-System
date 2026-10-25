/* global chrome */
const jobs = new Map();
const mailJobs = new Map();
const FANKE_MANAGE_URL = "https://i.jz.fkw.com/?siteId=0&_item=manageFrameFormManage";
const ALIMAIL_COMPOSE_URL = "https://qiye.aliyun.com/alimail/entries/v5.1/compose";
const ALIMAIL_INBOX_URL = "https://qiye.aliyun.com/alimail/entries/v5.1/mail/inbox/all";
const SITE_ORIGINS = new Set([
  "https://chem-e-car-registration.clever-morel-6302.chatgpt.site",
  "http://localhost",
  "http://localhost:3000",
]);

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function allowedSiteSender(sender) {
  try {
    const target = new URL(sender.url || sender.tab?.url || "");
    return SITE_ORIGINS.has(target.origin) || target.hostname === "localhost";
  } catch {
    return false;
  }
}

function safeDrafts(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 25) return null;
  const drafts = value.map((draft) => ({
    schoolName: typeof draft?.schoolName === "string" ? draft.schoolName.slice(0, 160) : "",
    recipient: typeof draft?.recipient === "string" ? draft.recipient.slice(0, 320) : "",
    subject: typeof draft?.subject === "string" ? draft.subject.slice(0, 300) : "",
    body: typeof draft?.body === "string" ? draft.body.slice(0, 30_000) : "",
  }));
  return drafts.every((draft) => draft.schoolName && draft.recipient && draft.subject && draft.body) ? drafts : null;
}

async function waitForTabComplete(tabId, timeout = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return null;
    if (tab.status === "complete") return tab;
    await delay(200);
  }
  return null;
}

async function injectHelper(tabId, filename, allFrames = false) {
  if (!chrome.scripting?.executeScript) return false;
  const result = await chrome.scripting.executeScript({
    target: { tabId, allFrames },
    files: [filename],
  }).then(() => true).catch(() => false);
  if (result) await delay(80);
  return result;
}

async function ensureAlibabaReceiver(tabId) {
  let probe = await chrome.tabs.sendMessage(tabId, { type: "CHEMECAR_ALIMAIL_PROBE" }).catch(() => null);
  if (probe?.ready) return true;
  await injectHelper(tabId, "alimail-draft.js");
  for (let attempt = 0; attempt < 15; attempt += 1) {
    probe = await chrome.tabs.sendMessage(tabId, { type: "CHEMECAR_ALIMAIL_PROBE" }).catch(() => null);
    if (probe?.ready) return true;
    await delay(120);
  }
  return false;
}

async function createAlibabaComposeTab() {
  const tab = await chrome.tabs.create({ url: ALIMAIL_COMPOSE_URL, active: true }).catch(() => null);
  if (!tab || typeof tab.id !== "number") return null;
  await waitForTabComplete(tab.id);
  return await ensureAlibabaReceiver(tab.id) ? tab : null;
}

async function fillDraftsInAlibabaTab(tab, drafts) {
  if (!tab || typeof tab.id !== "number" || !await ensureAlibabaReceiver(tab.id)) return null;
  return chrome.tabs.sendMessage(tab.id, {
    type: "CHEMECAR_ALIMAIL_FILL_DRAFTS",
    drafts,
  }).catch(() => null);
}

async function fillAlibabaDrafts(drafts) {
  const tabs = await chrome.tabs.query({ url: ["https://qiye.aliyun.com/*"] });
  tabs.sort((left, right) => {
    const leftScore = Number(Boolean(left.active)) + Number(/\/alimail\//i.test(left.url || ""));
    const rightScore = Number(Boolean(right.active)) + Number(/\/alimail\//i.test(right.url || ""));
    return rightScore - leftScore;
  });

  let tab = tabs.find((candidate) => typeof candidate.id === "number") || null;
  let response = tab ? await fillDraftsInAlibabaTab(tab, drafts) : null;
  if (!response) {
    tab = await createAlibabaComposeTab();
    response = tab ? await fillDraftsInAlibabaTab(tab, drafts) : null;
  }
  if (!response) {
    return { ok: false, message: "助手已尝试自动打开阿里邮箱写信页，但没有检测到有效登录状态。请先登录阿里邮箱，再回到本站重试；不需要手动刷新或进入写信页面。" };
  }
  if (response.ok && tab && typeof tab.id === "number") {
    await chrome.tabs.update(tab.id, { active: true }).catch(() => undefined);
    if (typeof tab.windowId === "number") await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
  }
  return response;
}

async function ensureAlibabaCollector(tabId) {
  let probe = await chrome.tabs.sendMessage(tabId, { type: "CHEMECAR_ALIMAIL_COLLECTOR_PROBE" }).catch(() => null);
  if (probe?.ready) return probe;
  await injectHelper(tabId, "alimail-collector.js");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    probe = await chrome.tabs.sendMessage(tabId, { type: "CHEMECAR_ALIMAIL_COLLECTOR_PROBE" }).catch(() => null);
    if (probe?.ready) return probe;
    await delay(150);
  }
  return null;
}

async function prepareAlibabaCollector() {
  const tabs = await chrome.tabs.query({ url: ["https://qiye.aliyun.com/*"] });
  let tab = tabs.find((candidate) => typeof candidate.id === "number" && /\/mail\/inbox(?:\/|$)/iu.test(candidate.url || "")) || null;
  if (!tab) {
    tab = await chrome.tabs.create({ url: ALIMAIL_INBOX_URL, active: false }).catch(() => null);
  }
  if (!tab || typeof tab.id !== "number") throw new Error("助手未能打开阿里邮箱收件箱。");
  if (!await waitForTabComplete(tab.id)) throw new Error("阿里邮箱收件箱加载超时，请确认网络和登录状态。");
  let probe = await ensureAlibabaCollector(tab.id);
  if (probe?.state === "logged_out") throw new Error("阿里邮箱尚未登录。请先登录一次，之后无需手动进入收件箱或刷新页面。");
  if (probe?.state !== "inbox_ready") {
    await chrome.tabs.update(tab.id, { url: ALIMAIL_INBOX_URL, active: false }).catch(() => null);
    if (!await waitForTabComplete(tab.id)) throw new Error("阿里邮箱自动进入收件箱超时。");
    probe = await ensureAlibabaCollector(tab.id);
  }
  if (probe?.state !== "inbox_ready") {
    throw new Error("助手已连接阿里邮箱，但无法识别收件箱。请确认已登录新版阿里邮箱后重试。");
  }
  return { tab, probe };
}

async function forwardAliMailEvent(requestId, message) {
  const job = mailJobs.get(requestId);
  if (!job) return;
  await chrome.tabs.sendMessage(job.siteTabId, message).catch(() => undefined);
  if (message.type === "CHEMECAR_ALIMAIL_SCAN_DONE" || message.type === "CHEMECAR_ALIMAIL_SCAN_ERROR") {
    mailJobs.delete(requestId);
  }
}

async function fankeFrameStates(tabId, injectWhenMissing = true) {
  const inspect = async () => {
    const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => []);
    const ordered = [...(frames || [])].sort((left, right) => {
      const leftHint = /siteFormSubmitManage|manageFrameFormManage/i.test(left.url || "") ? 1 : 0;
      const rightHint = /siteFormSubmitManage|manageFrameFormManage/i.test(right.url || "") ? 1 : 0;
      return rightHint - leftHint;
    });
    const states = [];
    for (const frame of ordered.length ? ordered : [{ frameId: 0, url: "" }]) {
      const probe = await chrome.tabs.sendMessage(tabId, { type: "FANKE_HELPER_PROBE" }, { frameId: frame.frameId }).catch(() => null);
      if (probe?.ready || probe?.manager) states.push({ tabId, frameId: frame.frameId, url: frame.url || "", ...probe });
    }
    return states;
  };

  let states = await inspect();
  if (!states.length && injectWhenMissing) {
    await injectHelper(tabId, "fanke-scraper.js", true);
    states = await inspect();
  }
  return states;
}

async function existingFankeWorkspace() {
  const tabs = await chrome.tabs.query({ url: ["https://*.fkw.com/*"] });
  tabs.sort((left, right) => Number(Boolean(right.active)) - Number(Boolean(left.active)));
  let manager = null;
  for (const tab of tabs) {
    if (typeof tab.id !== "number") continue;
    const states = await fankeFrameStates(tab.id);
    const ready = states.find((state) => state.ready);
    if (ready) return { ready, manager: null };
    manager ||= states.find((state) => state.manager) || null;
  }
  return { ready: null, manager };
}

async function waitForFankeState(tabId, predicate, timeout = 25_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const states = await fankeFrameStates(tabId, true);
    const matched = states.find(predicate);
    if (matched) return matched;
    await delay(180);
  }
  return null;
}

async function prepareFankeFrame(formId) {
  const existing = await existingFankeWorkspace();
  if (existing.ready) {
    const prepared = await chrome.tabs.sendMessage(existing.ready.tabId, {
      type: "FANKE_HELPER_PREPARE",
      formId,
    }, { frameId: existing.ready.frameId }).catch(() => null);
    if (prepared?.accepted) return existing.ready;
  }

  let manager = existing.manager;
  if (!manager) {
    const tab = await chrome.tabs.create({ url: FANKE_MANAGE_URL, active: false }).catch(() => null);
    if (!tab || typeof tab.id !== "number") throw new Error("助手未能打开凡科表单管理页。");
    if (!await waitForTabComplete(tab.id)) throw new Error("凡科表单管理页加载超时，请确认凡科已经登录。");
    await injectHelper(tab.id, "fanke-scraper.js", true);
    manager = await waitForFankeState(tab.id, (state) => state.ready || state.manager);
  }

  if (!manager) {
    throw new Error("助手已打开凡科后台，但没有检测到有效登录状态或目标表单。请先登录凡科；不需要手动进入“查看结果”或刷新页面。");
  }

  let resultFrame = manager.ready ? manager : null;
  if (!resultFrame) {
    const opened = await chrome.tabs.sendMessage(manager.tabId, {
      type: "FANKE_HELPER_OPEN_RESULTS",
      formId,
    }, { frameId: manager.frameId }).catch(() => null);
    if (!opened?.accepted) throw new Error(opened?.message || `凡科后台没有找到编号为 ${formId} 的表单“查看结果”入口。`);
    resultFrame = await waitForFankeState(manager.tabId, (state) => state.ready);
  }
  if (!resultFrame) throw new Error("已进入凡科表单，但结果清单加载超时，请稍后重试。");

  const prepared = await chrome.tabs.sendMessage(resultFrame.tabId, {
    type: "FANKE_HELPER_PREPARE",
    formId,
  }, { frameId: resultFrame.frameId }).catch(() => null);
  if (!prepared?.accepted) throw new Error(prepared?.message || "凡科结果页未能自动返回第一页。");
  return resultFrame;
}

async function forwardToSite(requestId, message) {
  const job = jobs.get(requestId);
  if (!job) return;
  await chrome.tabs.sendMessage(job.siteTabId, message).catch(() => undefined);
  if (message.type === "FANKE_HELPER_DONE" || message.type === "FANKE_HELPER_ERROR") jobs.delete(requestId);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return undefined;
  if (message.type === "FANKE_HELPER_ALIMAIL_DRAFTS") {
    if (!allowedSiteSender(sender)) {
      sendResponse({ ok: false, message: "此页面无权调用阿里邮箱草稿功能。" });
      return undefined;
    }
    const drafts = safeDrafts(message.drafts);
    if (!drafts) {
      sendResponse({ ok: false, message: "回执草稿数据不完整或单批数量过多。" });
      return undefined;
    }
    fillAlibabaDrafts(drafts).then(sendResponse).catch(() => sendResponse({ ok: false, message: "采集助手未能连接阿里邮箱页面。" }));
    return true;
  }
  if (message.type === "CHEMECAR_ALIMAIL_SCAN_START") {
    if (!allowedSiteSender(sender) || typeof sender.tab?.id !== "number") {
      sendResponse({ accepted: false, message: "此页面无权启动阿里邮箱媒体扫描。" });
      return undefined;
    }
    (async () => {
      if (!["poster", "video"].includes(message.kind)) {
        sendResponse({ accepted: false, message: "阿里邮箱媒体栏目只能是海报或视频。" });
        return;
      }
      try {
        const prepared = await prepareAlibabaCollector();
        mailJobs.set(message.requestId, { siteTabId: sender.tab.id, mailTabId: prepared.tab.id });
        const response = await chrome.tabs.sendMessage(prepared.tab.id, {
          type: "CHEMECAR_ALIMAIL_SCAN_START",
          requestId: message.requestId,
          kind: message.kind,
          startsAt: message.startsAt,
        }).catch(() => null);
        if (!response?.accepted) {
          mailJobs.delete(message.requestId);
          sendResponse({ accepted: false, message: response?.message || "阿里邮箱收件箱尚未准备好。" });
          return;
        }
        sendResponse({ accepted: true, mailboxKey: prepared.probe.mailboxKey || "alimail-inbox" });
      } catch (error) {
        mailJobs.delete(message.requestId);
        sendResponse({ accepted: false, message: error instanceof Error ? error.message : "阿里邮箱自动导航失败。" });
      }
    })();
    return true;
  }
  if (message.type === "CHEMECAR_ALIMAIL_API_REQUEST") {
    const job = mailJobs.get(message.requestId);
    if (!job || sender.tab?.id !== job.mailTabId) {
      sendResponse({ ok: false, message: "阿里邮箱扫描任务已结束或来源不匹配。" });
      return undefined;
    }
    chrome.tabs.sendMessage(job.siteTabId, message)
      .then((response) => sendResponse(response || { ok: false, message: "赛事资料中心未返回接口结果。" }))
      .catch(() => sendResponse({ ok: false, message: "赛事资料中心页面已关闭，扫描已暂停。" }));
    return true;
  }
  if (["CHEMECAR_ALIMAIL_SCAN_PROGRESS", "CHEMECAR_ALIMAIL_SCAN_DONE", "CHEMECAR_ALIMAIL_SCAN_ERROR"].includes(message.type)) {
    const job = mailJobs.get(message.requestId);
    if (!job || sender.tab?.id !== job.mailTabId) {
      sendResponse({ forwarded: false });
      return undefined;
    }
    forwardAliMailEvent(message.requestId, message)
      .then(() => sendResponse({ forwarded: true }))
      .catch(() => sendResponse({ forwarded: false }));
    return true;
  }
  if (message.type === "FANKE_HELPER_START") {
    (async () => {
      if (!["registration", "edp"].includes(message.targetKind)) {
        sendResponse({ accepted: false, message: "凡科只采集报名表和 EDP；海报和视频请使用阿里邮箱采集。" });
        return;
      }
      if (typeof sender.tab?.id !== "number") {
        sendResponse({ accepted: false, message: "无法识别赛事资料中心页面。" });
        return;
      }
      try {
        const frame = await prepareFankeFrame(message.formId);
        jobs.set(message.requestId, { siteTabId: sender.tab.id, fankeTabId: frame.tabId });
        const response = await chrome.tabs.sendMessage(frame.tabId, {
          type: "FANKE_HELPER_COLLECT",
          requestId: message.requestId,
          formId: message.formId,
          startsAt: message.startsAt,
          targetKind: message.targetKind,
        }, { frameId: frame.frameId }).catch(() => null);
        if (!response?.accepted) {
          jobs.delete(message.requestId);
          sendResponse({ accepted: false, message: response?.message || "凡科结果清单尚未加载完成，请稍后重试。" });
          return;
        }
        sendResponse({ accepted: true });
      } catch (error) {
        sendResponse({ accepted: false, message: error instanceof Error ? error.message : "凡科自动导航失败。" });
      }
    })();
    return true;
  }
  if (["FANKE_HELPER_PROGRESS", "FANKE_HELPER_RECORDS", "FANKE_HELPER_DONE", "FANKE_HELPER_ERROR"].includes(message.type)) {
    forwardToSite(message.requestId, message).then(() => sendResponse({ forwarded: true })).catch(() => sendResponse({ forwarded: false }));
    return true;
  }
  return undefined;
});
