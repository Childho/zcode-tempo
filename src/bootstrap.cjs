"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { app, webContents } = require("electron");
const { requestEnhancement } = require("./enhance-request.cjs");

const signalName = "[harness-zcode:request]";
const rendererEntry = path.join(process.resourcesPath, "app.asar", "out", "renderer", "index.html");

function rendererModule(filename) {
  const code = fs.readFileSync(path.join(__dirname, filename), "utf8");
  return `(function () { const module = { exports: {} }; ${code}\nreturn module.exports; })()`;
}

const program = `(() => {
  if (window.__harnessZCode) return;
  const rate = ${rendererModule("rate.cjs")};
  const enhancement = ${rendererModule("enhancement.cjs")};
  const requests = new Map();
  let queued = null;
  window.__harnessZCode = Object.freeze({
    takeRequest() {
      const value = queued;
      queued = null;
      return value;
    },
    deliver(id, result) {
      const settle = requests.get(id);
      if (settle) settle(result);
    },
  });
  function request(payload) {
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      const timeout = setTimeout(() => settle({ ok: false, error: "提示词增强超时，已保留草稿" }), 75000);
      function settle(result) {
        clearTimeout(timeout);
        requests.delete(id);
        if (queued?.id === id) queued = null;
        resolve(result);
      }
      requests.set(id, settle);
      queued = { ...payload, id };
      console.info(${JSON.stringify(signalName)});
    });
  }
  rate.installRate({ window, document });
  enhancement.installEnhancement({ window, document, getComposerProps: rate.getComposerProps, request });
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
  let controller = null;

  const inject = () => {
    if (!trustedWindow(contents)) return;
    void contents.executeJavaScript(program).catch(() => {
      console.error("[harness-zcode] cannot initialize the local conversation window");
    });
  };

  async function handleRequest() {
    if (!trustedWindow(contents) || controller) return;
    const active = new AbortController();
    controller = active;
    try {
      const request = await contents.executeJavaScript("window.__harnessZCode?.takeRequest() ?? null");
      if (!request || !/^[0-9a-f-]{36}$/iu.test(request.id)) return;
      const result = await requestEnhancement({
        providerId: request.providerId,
        modelId: request.modelId,
        text: request.text,
        signal: active.signal,
        dataBaseDir: process.env.ZCODE_DATA_BASE_DIR,
      });
      if (!active.signal.aborted && trustedWindow(contents)) {
        // 先清理本请求，避免页面写回后发出的下一次合法手势赶到锁的释放之前。
        if (controller === active) controller = null;
        await contents.executeJavaScript(`window.__harnessZCode?.deliver(${serialize(request.id)}, ${serialize(result)})`);
      }
    } catch {
      if (trustedWindow(contents)) console.error("[harness-zcode] prompt enhancement transport failed");
    } finally {
      if (controller === active) controller = null;
    }
  }

  contents.on("dom-ready", inject);
  contents.on("did-finish-load", inject);
  contents.on("destroyed", () => controller?.abort());
  contents.on("did-start-navigation", (_event, _url, sameDocument, mainFrame) => {
    if (mainFrame && !sameDocument) controller?.abort();
  });
  // 只在手势产生请求时唤醒主进程，传输信号本身不包含草稿或凭据。
  contents.on("console-message", (_event, details, legacyMessage) => {
    if ((details?.message || legacyMessage) !== signalName) return;
    if (details?.frame && details.frame !== contents.mainFrame) return;
    void handleRequest();
  });
  if (!contents.isLoading()) inject();
}

app.on("web-contents-created", (_event, contents) => wire(contents));
for (const contents of webContents.getAllWebContents()) wire(contents);
