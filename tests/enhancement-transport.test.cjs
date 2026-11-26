"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { setImmediate } = require("node:timers/promises");
const { fileURLToPath, pathToFileURL } = require("node:url");
const vm = require("node:vm");
const test = require("node:test");

function fixture() {
  const handlers = new Map();
  const timers = new Map();
  const requests = new Map();
  let timerId = 0;
  const resourcePath = path.resolve("fixture-resources");
  const frame = {};
  const window = {};
  const renderer = vm.createContext({
    window, document: {}, crypto: { randomUUID },
    console: { info: (message) => handlers.get("console-message")({}, { frame, message }) },
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  const contents = {
    mainFrame: frame,
    getType: () => "window", isDestroyed: () => false, isLoading: () => false,
    getURL: () => pathToFileURL(path.join(resourcePath, "app.asar/out/renderer/index.html")).href,
    on: (event, handler) => handlers.set(event, handler),
    async executeJavaScript(code) { return vm.runInContext(code, renderer); },
  };
  const dependencies = {
    "node:fs": { readFileSync(filename) {
      const moduleName = path.basename(filename);
      if (moduleName === "markdown-fences.cjs" || moduleName === "reply-context.cjs") return fs.readFileSync(filename, "utf8");
      if (moduleName === "enhancement.cjs") {
        return "module.exports = { installEnhancement({window, request}) { window.testRequest = request; } };";
      }
      return "module.exports = { installRate() {} };";
    } },
    "node:path": path,
    "node:url": { fileURLToPath },
    electron: { app: { on() {} }, webContents: { getAllWebContents: () => [contents] } },
    "./enhance-request.cjs": {
      requestEnhancement(options) {
        const deferred = Promise.withResolvers();
        requests.set(options.text, { ...deferred, ...options });
        return deferred.promise;
      },
      requestPrediction(options) {
        const deferred = Promise.withResolvers();
        requests.set(options.previousUser, { ...deferred, ...options });
        return deferred.promise;
      },
    },
  };
  const file = path.join(__dirname, "../src/bootstrap.cjs");
  vm.runInNewContext(fs.readFileSync(file, "utf8"), {
    require: (name) => dependencies[name], __dirname: path.dirname(file), AbortController, console,
    process: { resourcesPath: resourcePath, platform: process.platform, env: {} },
  }, { filename: file });
  return {
    request: (text) => window.testRequest({ providerId: "fixture", modelId: "fixture-model", text }),
    predict: (signal) => window.testRequest({
      providerId: "fixture", modelId: "fixture-model", mode: "prediction", previousUser: "last user", previousReply: "last reply",
    }, { signal }),
    requests,
    expireFirst: () => timers.values().next().value(),
    navigate: () => handlers.get("did-navigate")?.(),
  };
}

test("不同草稿的请求都能发送，并可按不同顺序返回", async () => {
  const host = fixture();
  const first = host.request("first");
  const second = host.request("second");
  await setImmediate();
  assert.deepEqual([...host.requests.keys()], ["first", "second"]);
  host.requests.get("second").resolve({ ok: true, text: "second result" });
  assert.equal((await second).text, "second result");
  host.requests.get("first").resolve({ ok: true, text: "first result" });
  assert.equal((await first).text, "first result");
});

test("界面超时会取消对应请求，慢返回不阻塞重试", async () => {
  const host = fixture();
  const first = host.request("slow");
  await setImmediate();
  const slow = host.requests.get("slow");
  assert.ok(slow);
  host.expireFirst();
  assert.equal((await first).ok, false);
  const retry = host.request("retry");
  await setImmediate();
  assert.equal(slow.signal.aborted, true);
  assert.ok(host.requests.has("retry"));
  host.requests.get("retry").resolve({ ok: true, text: "retry result" });
  assert.equal((await retry).text, "retry result");
  slow.resolve({ ok: true, text: "late result" });
});

test("主页面换代会取消窗口内的在途请求", async () => {
  const host = fixture();
  void host.request("first");
  await setImmediate();
  host.navigate();
  assert.equal(host.requests.get("first").signal.aborted, true);
});

test("预测通过独立路由发送，可从渲染进程取消且迟到结果不会继续等待", async () => {
  const host = fixture();
  const controller = new AbortController();
  const pending = host.predict(controller.signal);
  await setImmediate();
  const prediction = host.requests.get("last user");
  assert.equal(prediction.previousReply, "last reply");
  assert.equal(prediction.text, undefined);
  controller.abort();
  assert.equal((await pending).kind, "cancelled");
  await setImmediate();
  assert.equal(prediction.signal.aborted, true);
  prediction.resolve({ ok: true, text: "after cancel" });
});
