/* global chrome */
(() => {
  const SITE_SOURCE = "chemecar-console";
  const HELPER_SOURCE = "chemecar-fanke-helper";
  const allowed = location.origin === "https://chem-e-car-registration.clever-morel-6302.chatgpt.site"
    || location.hostname === "localhost";
  if (!allowed) return;

  const sendToPage = (type, payload = {}) => {
    window.postMessage({ source: HELPER_SOURCE, type, ...payload }, location.origin);
  };

  async function handleAliMailApiRequest(api) {
    const method = typeof api?.method === "string" ? api.method.toUpperCase() : "GET";
    const path = typeof api?.path === "string" ? api.path : "";
    const allowedPath = /^\/api\/mail-browser\/(?:scans\/(?:start|batch|finish)|assets\/exists|state)$/u.test(path)
      || /^\/api\/media\/(?:poster|video)\/multipart\/(?:create|[0-9a-f-]+(?:\/parts\/\d+|\/complete)?)$/iu.test(path);
    if (!allowedPath || !["GET", "POST", "PUT"].includes(method)) {
      return { ok: false, message: "采集助手拒绝了不在允许清单中的接口请求。" };
    }
    const headers = new Headers(api?.headers && typeof api.headers === "object" ? api.headers : {});
    headers.delete("Content-Length");
    let body;
    if (api && Object.prototype.hasOwnProperty.call(api, "json")) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(api.json);
    } else if (api?.body instanceof ArrayBuffer) {
      body = api.body;
    } else if (ArrayBuffer.isView(api?.body)) {
      body = api.body.buffer.slice(api.body.byteOffset, api.body.byteOffset + api.body.byteLength);
    }
    const response = await fetch(path, { method, headers, body, credentials: "same-origin", cache: "no-store" });
    const payload = await response.json().catch(() => ({ ok: false, error: { message: `接口返回 HTTP ${response.status}` } }));
    if (!response.ok) return { ok: false, status: response.status, payload, message: payload?.error?.message || `接口返回 HTTP ${response.status}` };
    return { ok: true, status: response.status, payload };
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.source !== SITE_SOURCE || typeof message.type !== "string") return;
    if (message.type === "FANKE_HELPER_PING") {
      sendToPage("FANKE_HELPER_READY", { version: chrome.runtime.getManifest().version });
      return;
    }
    if (message.type === "FANKE_HELPER_ALIMAIL_DRAFTS") {
      chrome.runtime.sendMessage({
        type: "FANKE_HELPER_ALIMAIL_DRAFTS",
        requestId: message.requestId,
        drafts: message.drafts,
      }).then((response) => sendToPage("FANKE_HELPER_ALIMAIL_RESULT", {
        requestId: message.requestId,
        ...(response || { ok: false, message: "采集助手后台未返回草稿处理结果。" }),
      })).catch(() => sendToPage("FANKE_HELPER_ALIMAIL_RESULT", {
        requestId: message.requestId,
        ok: false,
        message: "采集助手后台未响应，请在浏览器扩展管理页重新启用助手。",
      }));
      return;
    }
    if (message.type === "CHEMECAR_ALIMAIL_SCAN_START") {
      chrome.runtime.sendMessage({
        type: "CHEMECAR_ALIMAIL_SCAN_START",
        requestId: message.requestId,
        kind: message.kind,
        startsAt: message.startsAt,
      }).then((response) => {
        if (!response?.accepted) sendToPage("CHEMECAR_ALIMAIL_SCAN_ERROR", {
          requestId: message.requestId,
          kind: message.kind,
          message: response?.message || "采集助手未能启动阿里邮箱扫描。",
        });
      }).catch(() => sendToPage("CHEMECAR_ALIMAIL_SCAN_ERROR", {
        requestId: message.requestId,
        kind: message.kind,
        message: "采集助手后台未响应，请在扩展管理页重新启用助手。",
      }));
      return;
    }
    if (message.type !== "FANKE_HELPER_START") return;
    chrome.runtime.sendMessage({
      type: "FANKE_HELPER_START",
      requestId: message.requestId,
      formId: message.formId,
      startsAt: message.startsAt,
      targetKind: message.targetKind,
    }).then((response) => {
      if (!response?.accepted) sendToPage("FANKE_HELPER_ERROR", {
        requestId: message.requestId,
        message: response?.message || "采集助手未能启动。",
      });
    }).catch(() => sendToPage("FANKE_HELPER_ERROR", {
      requestId: message.requestId,
      message: "采集助手后台未响应，请在浏览器扩展管理页重新启用助手。",
    }));
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return undefined;
    if (message.type === "CHEMECAR_ALIMAIL_API_REQUEST") {
      handleAliMailApiRequest(message.api)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, message: error instanceof Error ? error.message : "赛事资料中心接口调用失败。" }));
      return true;
    }
    if (message.type.startsWith("FANKE_HELPER_") || message.type.startsWith("CHEMECAR_ALIMAIL_SCAN_")) {
      sendToPage(message.type, message);
    }
    return undefined;
  });

  sendToPage("FANKE_HELPER_READY", { version: chrome.runtime.getManifest().version });
})();
