"use strict";

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const root = path.join(os.tmpdir(), "harness-zcode-4-e2e");
const providerId = "harness-fixture";
const modelId = "harness-test-model";

function isolateWindowsRegistration(app) {
  const patch = String.raw`
import os
import sys
from pathlib import Path
from tempfile import NamedTemporaryFile, gettempdir

sys.path.insert(0, sys.argv[1])
from scripts.install import inspect, write_archive

archive = Path(sys.argv[2]).resolve(strict=True)
app = (Path(gettempdir()) / "harness-zcode-4-e2e" / "app").resolve(strict=True)
if archive != app / "resources" / "app.asar":
    raise ValueError("Unable to isolate a non-fixture archive")
changes = {
    b'function pP(e,t={}){let r="zcode";': b'function pP(e,t={}){return;let r="zcode";',
    b'async function Tf(e){if(e.platform!=="win32")return;': b'async function Tf(e){return;if(e.platform!=="win32")return;',
    b'ee.clearRecentDocuments()': b'void 0/* harness-test recent documents */',
    b'...w,autoPrepare:p': b'...w,autoPrepare:!1',
    b'throw v.error("[arms] electron init failed:",e),e': b'v.error("[arms] fixture skipped:",e)',
    b'bI({enabled:ut==="production"&&Ch,onBeforeQuitAndInstall:': b'bI({enabled:!1,onBeforeQuitAndInstall:',
}
temp = None
try:
    with archive.open("rb") as source:
        header, base, entry, content = inspect(source)
        if all(content.count(new) == 1 for new in changes.values()):
            sys.exit(0)
        for old, new in changes.items():
            if content.count(new) == 1 and old not in content:
                continue
            if content.count(old) != 1 or new in content:
                raise ValueError("ZCode 4.0.0 fixture anchor changed")
            content = content.replace(old, new)
        with NamedTemporaryFile(dir=archive.parent, delete=False) as destination:
            temp = Path(destination.name)
            write_archive(source, destination, header, base, entry, content)
    with temp.open("rb") as result:
        if inspect(result)[3] != content:
            raise ValueError("Fixture archive verification failed")
    os.replace(temp, archive)
finally:
    if temp:
        temp.unlink(missing_ok=True)
`;
  const result = spawnSync("python", ["-B", "-c", patch, path.resolve(__dirname, ".."), path.join(app, "resources", "app.asar")], {
    windowsHide: true, encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || "隔离 Windows 注册失败");
}

function seed(home, baseUrl) {
  const v2 = path.join(home, ".zcode", "v2");
  fs.mkdirSync(v2, { recursive: true });
  const defaultModelSelection = { providerId, modelId, options: { reasoningLevel: "disabled" } };
  const config = {
    providerOrder: [providerId], defaultModelSelection,
    providerConfigRules: { providerRules: [{
      providerId, providerName: "Harness Fixture",
      config: {
        group: "standard-personal", access: { type: "api-key", apiKey: "fixture-only-key" },
        api: { type: "openai-chat-completions", baseUrl }, personalModelIds: [modelId],
      },
    }] },
    modelConfigRules: { manualProviderModelRules: [], providerModelRules: [{
      providerId, modelId, config: {
        enabled: true,
        properties: {
          contextWindow: 200000,
          inputFormat: { supportsText: true, supportsImage: false, supportsAudio: false, supportsVideo: false, supportsPdf: false },
          outputFormat: { supportsText: true }, supportsToolCall: true,
          supportsJsonSchemaOutput: false, supportsNativeWebSearch: false,
          supportsMidConversationSystem: false, requiresMfjsToolSchema: false,
        },
        optionSpecs: { reasoningLevel: { values: ["disabled"], map: "{}" }, maxOutputTokens: { max: 32000 } },
      },
    }] },
  };
  fs.writeFileSync(path.join(v2, "provider_config.json"), JSON.stringify({ schemaVersion: 1, config }));
  fs.writeFileSync(path.join(v2, "setting.json"), JSON.stringify({
    dataBaseDir: home, memoryEnabled: false, proactiveSuggestionsEnabled: false, uiLocale: "zh-CN",
  }));
  fs.writeFileSync(path.join(v2, "onboarding-record.json"), JSON.stringify({
    version: 2, deviceMid: "harness-fixture", entries: [],
    decisions: [{ userId: null, status: "dismissed", reason: "user_closed", decidedAt: new Date().toISOString() }],
  }));
}

function json(res, value, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

async function replyWithStream(res) {
  const id = "chatcmpl-harness-fixture";
  const envelope = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: modelId };
  const write = (event) => res.write(`data: ${JSON.stringify({ ...envelope, ...event })}\n\n`);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.flushHeaders();
  await delay(200);
  write({ choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
  for (let count = 1; count <= 18 && !res.destroyed; count++) {
    await delay(130);
    write({ choices: [{ index: 0, delta: { content: `模拟输出第 ${count} 段。` }, finish_reason: null }] });
  }
  if (res.destroyed) return;
  write({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  write({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 130, total_tokens: 250 } });
  res.end("data: [DONE]\n\n");
}

async function capture(debugPort, run) {
  const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((result) => result.json());
  const target = targets.find((item) => item.type === "page" && item.url.includes("/out/renderer/index.html"));
  if (!target?.webSocketDebuggerUrl) throw new Error("找不到 ZCode 主窗口");
  const client = new WebSocket(target.webSocketDebuggerUrl);
  const reply = Promise.withResolvers();
  const timer = setTimeout(() => reply.reject(new Error("截图超时")), 5000);
  client.addEventListener("open", () => client.send(JSON.stringify({ id: 1, method: "Page.captureScreenshot" })));
  client.addEventListener("message", (event) => {
    const response = JSON.parse(event.data);
    if (response.id === 1) reply.resolve(response.result?.data);
  });
  client.addEventListener("error", () => reply.reject(new Error("连接截图端口失败")));
  try {
    const data = await reply.promise;
    if (!data) throw new Error("截图失败");
    const file = path.join(run, `screenshot-${Date.now()}.png`);
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    return file;
  } finally {
    clearTimeout(timer);
    client.close();
  }
}

async function main() {
  const app = fs.realpathSync(path.join(root, "app"));
  if (path.relative(fs.realpathSync(root), app) !== "app") throw new Error("隔离副本必须位于测试临时目录");
  const exe = fs.realpathSync(path.join(app, "ZCode.exe"));
  if (path.dirname(exe) !== app) throw new Error("隔离客户端路径无效");
  isolateWindowsRegistration(app);
  const run = fs.mkdtempSync(path.join(root, "run-"));
  const home = path.join(run, "home");
  const workspace = path.join(home, "ZCodeProject");
  const sessionData = path.join(run, "electron", "session");
  const roamingData = path.join(home, "AppData", "Roaming");
  const localData = path.join(home, "AppData", "Local");
  for (const directory of [workspace, sessionData, roamingData, localData]) fs.mkdirSync(directory, { recursive: true });
  const counts = { stream: 0, enhancement: 0, other: 0 };
  let debugPort;
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === "/fixture/requests") return json(res, counts);
      if (req.url === "/fixture/screenshot") return json(res, { path: await capture(debugPort, run) });
      if (req.url === "/v1/models") return json(res, { object: "list", data: [{ id: modelId, object: "model" }] });
      if (req.url !== "/v1/chat/completions" || req.method !== "POST") return json(res, { data: [] });
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks));
      if (input.stream) {
        counts.stream++;
        await replyWithStream(res);
        return;
      }
      const isEnhancement = input.messages?.some((message) => message.role === "system" &&
        typeof message.content === "string" && message.content.includes("Prompt Engineering Expert"));
      counts[isEnhancement ? "enhancement" : "other"]++;
      if (isEnhancement) await delay(1200);
      const formattedDraft = typeof input.messages?.at(-1)?.content === "string" ? input.messages.at(-1).content : "";
      const match = formattedDraft.match(/^User draft \(JSON string\):\n([^\n]+)\n/u);
      const draft = match ? JSON.parse(match[1]) : "";
      const content = isEnhancement ? `增强结果：${draft.replace("npm test -- --watch=false", "npm test")}` : "ZCode fixture";
      json(res, {
        id: "chatcmpl-harness-fixture", object: "chat.completion", model: modelId,
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
        usage: { prompt_tokens: 60, completion_tokens: 30, total_tokens: 90 },
      });
    } catch (error) {
      if (!res.headersSent) json(res, { error: String(error.message) }, 500);
      else res.destroy();
    }
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const mockPort = server.address().port;
  seed(home, `http://127.0.0.1:${mockPort}/v1`);

  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ZCODE_|OPENAI_|ANTHROPIC_|ELECTRON_)/iu.test(key)));
  Object.assign(env, {
    USERPROFILE: home,
    APPDATA: roamingData,
    LOCALAPPDATA: localData,
    ZCODE_DATA_BASE_DIR: home,
    ZCODE_HOME: path.join(home, ".zcode"),
    ZCODE_DESKTOP_HOME_DIR: home,
    ZCODE_DESKTOP_APPLICATION_NAME: "ZCode Harness Fixture",
    ZCODE_DESKTOP_USER_DATA_DIR: path.join(run, "electron"),
    ZCODE_DESKTOP_SESSION_DATA_DIR: sessionData,
    ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
    ZCODE_BASE_URL: `http://127.0.0.1:${mockPort}`,
  });
  const logPath = path.join(run, "app.log");
  const child = spawn(exe, ["--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", `--user-data-dir=${path.dirname(sessionData)}`, workspace], {
    cwd: app, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stdout.on("data", (chunk) => fs.appendFileSync(logPath, chunk));
  child.stderr.on("data", (chunk) => {
    fs.appendFileSync(logPath, chunk);
    if (debugPort) return;
    stderr = (stderr + String(chunk)).slice(-4000);
    const debug = stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//u);
    if (debug) {
      debugPort = Number(debug[1]);
      const status = { pid: child.pid, mockPort, debugPort, run, home, workspace, logPath, providerId, modelId };
      fs.writeFileSync(path.join(run, "fixture.json"), JSON.stringify(status));
      console.log(JSON.stringify(status));
    }
  });
  child.once("error", (error) => { console.error(error); server.close(); process.exitCode = 1; });
  child.once("exit", (code) => { server.close(); process.exitCode = code ?? 0; });
  const stop = () => {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    }
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.log(JSON.stringify({ pid: child.pid, mockPort, run, logPath }));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
