"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { app, webContents } = require("electron");
const { requestEnhancement, requestPrediction } = require("./enhance-request.cjs");

const signalName = "[harness-zcode:request]";
const REQUEST_TIMEOUT_MS = 75_000;
const rendererEntry = path.join(process.resourcesPath, "app.asar", "out", "renderer", "index.html");

function rendererModule(filename, dependencies = "{}") {
  const code = fs.readFileSync(path.join(__dirname, filename), "utf8");
  return `(function (dependencies) {
    const module = { exports: {} };
    const require = (name) => {
      if (!Object.hasOwn(dependencies, name)) throw new Error("Unknown renderer module " + name);
      return dependencies[name];
    };
    ${code}\nreturn module.exports; })(${dependencies})`;
}

const program = `(() => {
  if (window.__harnessZCode) return;
  const rate = ${rendererModule("rate.cjs")};
  const markdownFences = ${rendererModule("markdown-fences.cjs")};
  const replyContext = ${rendererModule("reply-context.cjs", '{ "./markdown-fences.cjs": markdownFences }')};
  const enhancement = ${rendererModule("enhancement.cjs")};
  const requests = new Map();
  const queued = [];
  window.__harnessZCode = Object.freeze({
    takeMessages() {
      return queued.splice(0);
    },
    deliver(id, result) {
      const settle = requests.get(id);
      if (settle) settle(result);
    },
  });
  function enqueue(message) {
    queued.push(message);
    console.info(${JSON.stringify(signalName)});
  }
  function request(payload, { signal } = {}) {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve({ ok: false, kind: "cancelled" });
        return;
      }
      const id = crypto.randomUUID();
      function cancel(result) {
        const index = queued.findIndex((message) => message.id === id);
        if (index >= 0) queued.splice(index, 1);
        else enqueue({ type: "cancel", id });
        settle(result);
      }
      const onAbort = () => cancel({ ok: false, kind: "cancelled" });
      const timeout = setTimeout(() => cancel({ ok: false, error: "提示词增强超时，已保留草稿" }), ${REQUEST_TIMEOUT_MS});
      function settle(result) {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        requests.delete(id);
        resolve(result);
      }
      requests.set(id, settle);
      signal?.addEventListener("abort", onAbort, { once: true });
      enqueue({ ...payload, type: "request", id });
    });
  }
  const composer = enhancement.installEnhancement({ window, document, getComposerProps: rate.getComposerProps, replyContext, request });
  rate.installRate({ window, document, onComposer: composer?.observeComposer });
})();`;

function trustedWindow(contents) {
  if (contents.isDestroyed() || contents.getType() !== "window") return false;
  try {
    const actual = path.normalize(fileURLToPath(contents.getURL()));
    return process.platform === "win32"
      ? actual.toLowerCase() === rendererEntry.toLowerCase()
      : actual === rendererEntry;
  } catch {
    return false;
  }
}

function serialize(value) {
  return JSON.stringify(value).replace(/[\u2028\u2029]/gu, (letter) => letter === "\u2028" ? "\\u2028" : "\\u2029");
}

const wired = new WeakSet();
function wire(contents) {
  if (wired.has(contents) || contents.getType() !== "window") return;
  wired.add(contents);
  const activeRequests = new Map();
  let page = 0;
  let draining = false;
  let signalled = false;

  const inject = () => {
    if (!trustedWindow(contents)) return;
    void contents.executeJavaScript(program).catch(() => {
      console.error("[harness-zcode] cannot initialize the local conversation window");
    });
  };

  async function handleRequest(request) {
    const active = new AbortController();
    activeRequests.set(request.id, active);
    let result;
    try {
      const options = {
        providerId: request.providerId,
        modelId: request.modelId,
        signal: active.signal,
        dataBaseDir: process.env.ZCODE_DATA_BASE_DIR,
      };
      result = request.mode === "prediction"
        ? await requestPrediction({ ...options, previousUser: request.previousUser, previousReply: request.previousReply })
        : await requestEnhancement({ ...options, text: request.text, previousReply: request.previousReply });
    } catch {
      result = { ok: false, error: "提示词增强失败，已保留草稿" };
    }
    if (activeRequests.get(request.id) !== active) return;
    activeRequests.delete(request.id);
    if (!trustedWindow(contents)) return;
    try {
      await contents.executeJavaScript(`window.__harnessZCode?.deliver(${serialize(request.id)}, ${serialize(result)})`);
    } catch {
      if (trustedWindow(contents)) console.error("[harness-zcode] prompt enhancement transport failed");
    }
  }

  async function drainMessages() {
    signalled = true;
    if (draining) return;
    draining = true;
    try {
      // 读取期间收到的新信号留给下一批，不因在途请求而丢失。
      while (signalled && trustedWindow(contents)) {
        signalled = false;
        const pageAtRead = page;
        let messages;
        try {
          messages = await contents.executeJavaScript("window.__harnessZCode?.takeMessages() ?? []");
        } catch {
          if (page === pageAtRead && trustedWindow(contents)) console.error("[harness-zcode] prompt enhancement transport failed");
          continue;
        }
        if (page !== pageAtRead || !trustedWindow(contents) || !Array.isArray(messages)) continue;
        for (const message of messages) {
          if (typeof message?.id !== "string" || !/^[0-9a-f-]{36}$/iu.test(message.id)) continue;
          if (message.type === "cancel") {
            const active = activeRequests.get(message.id);
            activeRequests.delete(message.id);
            active?.abort();
          } else if (message.type === "request" && !activeRequests.has(message.id)) {
            void handleRequest(message);
          }
        }
      }
    } finally {
      draining = false;
    }
  }

  function invalidatePage() {
    page++;
    signalled = false;
    for (const active of activeRequests.values()) active.abort();
    activeRequests.clear();
  }

  contents.on("dom-ready", inject);
  contents.on("did-finish-load", inject);
  contents.on("destroyed", invalidatePage);
  contents.on("did-navigate", invalidatePage);
  // 请求入队时唤醒主进程，传输信号本身不包含会话内容或凭据。
  contents.on("console-message", (_event, details, legacyMessage) => {
    if ((details?.message || legacyMessage) !== signalName) return;
    if (details?.frame && details.frame !== contents.mainFrame) return;
    void drainMessages();
  });
  if (!contents.isLoading()) inject();
}

app.on("web-contents-created", (_event, contents) => wire(contents));
for (const contents of webContents.getAllWebContents()) wire(contents);
