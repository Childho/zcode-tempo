"use strict";

const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { promisify } = require("node:util");

const runFile = promisify(execFile);

async function until(read, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`等待超时 ${label}`);
}

async function connect(port) {
  const endpoint = await until(async () => {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return pages.find((page) => page.type === "page" && page.url.includes("/out/renderer/index.html"));
    } catch {
      return null;
    }
  }, "ZCode 主窗口");
  const socket = new WebSocket(endpoint.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let sequence = 0;
  const inflight = new Map();
  socket.addEventListener("message", ({ data }) => {
    const response = JSON.parse(data);
    const handlers = inflight.get(response.id);
    if (!handlers) return;
    inflight.delete(response.id);
    clearTimeout(handlers.timer);
    if (response.error) handlers.reject(new Error(response.error.message));
    else handlers.resolve(response.result);
  });
  function call(method, params = {}) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        inflight.delete(id);
        reject(new Error(`桌面命令超时 ${method}`));
      }, 10000);
      inflight.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ method, params, id }));
    });
  }
  async function evaluate(expression) {
    const { result, exceptionDetails } = await call("Runtime.evaluate", { expression, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  }
  return { call, evaluate, targetId: endpoint.id, close: () => socket.close() };
}

const ACTIVE = `Array.from(document.querySelectorAll('[data-testid="v4-composer-input"]')).find(element => element.getClientRects().length)`;
const PANE = `document.querySelector('[data-testid="v4-session-pane-workspace-main"]')`;
const RATE = `(${ACTIVE})?.closest('.chat-composer-input-surface')?.querySelector('[data-testid="harness-generation-rate"]')`;
const PREVIEW = `(${ACTIVE})?.parentElement?.querySelector('[data-testid="harness-prediction-preview"]')`;
const ENHANCEMENT_STATUS = `(() => {
  const input = (${ACTIVE});
  const floating = input?.closest('[data-side-pane-full-view-host="floating"]');
  const selector = '[data-testid="harness-enhancement-status"]';
  if (!floating) return input?.closest('[data-testid="v4-composer"]')?.querySelector(selector);
  const anchor = input.closest('form')?.querySelector('.harness-enhancement-status-anchor');
  return anchor && Array.from(floating.querySelectorAll(':scope > .harness-enhancement-status-slot'))
    .find((slot) => slot.style.positionAnchor === anchor.style.anchorName)?.querySelector(selector);
})()`;
const RATE_TEXT = /^\d+(?:\.\d+)? tok\/s$/u;

async function readDraft(client) {
  return client.evaluate(`(${ACTIVE})?.__zcodeLexicalInputE2E?.getText()`);
}

async function enhancementStatus(client) {
  return client.evaluate(`(${ENHANCEMENT_STATUS})?.textContent || ''`);
}

async function enhancementStatusLayout(client) {
  return client.evaluate(`(() => {
    const input = (${ACTIVE});
    const status = (${ENHANCEMENT_STATUS});
    const actions = input.closest('[data-testid="v4-composer"]').querySelector('[data-composer-leading-actions]');
    const leadingContent = actions.querySelector('[data-composer-leading-content]');
    const toolbar = actions.parentElement;
    const bounds = (element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return [x, y, width, height];
    };
    const statusBox = status.getBoundingClientRect();
    const actionsBox = actions.getBoundingClientRect();
    const textRange = document.createRange();
    textRange.selectNodeContents(status);
    const textBox = textRange.getBoundingClientRect();
    const compact = getComputedStyle(status).position === 'absolute';
    const floating = input.closest('[data-composer-layout="inline"]');
    const floatingBox = floating?.getBoundingClientRect();
    const slot = floating
      ? status.parentElement.parentElement === input.closest('[data-side-pane-full-view-host="floating"]')
        && Math.abs(statusBox.bottom - floatingBox.top) <= .5
        && statusBox.left >= floatingBox.left && statusBox.right <= floatingBox.right
      : compact
        ? statusBox.top >= input.getBoundingClientRect().bottom - .5 && statusBox.bottom <= actionsBox.top + .5
        : statusBox.left >= leadingContent.getBoundingClientRect().right - .5 && statusBox.right <= actionsBox.right + .5;
    const pointerEvents = getComputedStyle(status).pointerEvents;
    const inlinePointerEvents = status.style.pointerEvents;
    status.style.pointerEvents = 'auto';
    const y = statusBox.top + statusBox.height / 2;
    const painted = textBox.width > 2 && [textBox.left + 1, textBox.right - 1].every(
      (x) => document.elementFromPoint(x, y) === status);
    status.style.pointerEvents = inlinePointerEvents;
    return {
      geometry: {
        toolbar: bounds(toolbar), input: bounds(input), actions: bounds(actions),
        controls: Array.from(toolbar.querySelectorAll('button')).filter((node) => node.getClientRects().length).map(bounds),
      },
      focused: document.activeElement === input,
      slot, compact, floating: !!floating,
      textFits: painted && textBox.left >= statusBox.left - .5 && textBox.right <= statusBox.right + .5
        && textBox.left >= 0 && textBox.right <= innerWidth,
      pointerEvents,
      role: status.getAttribute('role'),
    };
  })()`);
}

async function exerciseFloatingEnhancementStatus(client) {
  const floating = `(${ACTIVE})?.closest('[data-composer-layout="inline"]')`;
  if (!await client.evaluate(`!!(${floating})`) && !await click(client, "side-pane-full-view-toggle")) {
    await until(() => click(client, "side-pane-toggle"), "打开侧边面板");
    await until(() => click(client, "side-pane-full-view-toggle"), "打开浮动输入框");
  }
  await until(() => client.evaluate(`!!(${floating}) && !!(${ENHANCEMENT_STATUS})`), "浮动输入框和状态区就绪");
  const draft = "请优化浮动输入框中的草稿 HARNESS_RETURN_UNCHANGED";
  await setDraft(client, draft);
  await delay(300);
  const before = await enhancementStatusLayout(client);
  // 浮动工作台会保留隐藏分屏，用模拟的空闲输入框检查扫描是否清掉当前草稿的提示。
  await client.evaluate(`(() => {
    const host = (${floating}).closest('[data-side-pane-full-view-host="floating"]');
    const pane = document.createElement('div');
    pane.id = 'harness-test-idle-split';
    pane.hidden = true;
    pane.innerHTML = '<div data-testid="v4-composer"><form><div data-composer-layout="inline">' +
      '<div data-testid="v4-composer-input"></div></div></form></div>';
    host.append(pane);
  })()`);
  try {
    await threeSpaces(client);
    assert.equal(await enhancementStatus(client), "正在增强…");
    await client.call("Runtime.evaluate", {
      expression: "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      awaitPromise: true,
    });
    assert.equal(await enhancementStatus(client), "正在增强…", "空闲分屏的扫描不会清掉原草稿提示");
    const waiting = await enhancementStatusLayout(client);
    assert.deepEqual(waiting.geometry, before.geometry, "浮动输入框和工具栏控件位置保持");
    assert.ok(waiting.focused && waiting.floating && waiting.slot && waiting.textFits, "浮动输入框完整显示等待提示");
    await until(async () => await enhancementStatus(client) === "增强完成，草稿未改动", "浮动输入框显示完成提示");
    const completed = await enhancementStatusLayout(client);
    assert.ok(completed.floating && completed.slot && completed.textFits, "浮动输入框完整显示完成提示");
    assert.equal(await readDraft(client), draft);
    await until(async () => await enhancementStatus(client) === "", "浮动输入框的完成提示自动消失");
    console.log(JSON.stringify({ enhancementStatus: "fully-visible", composer: "floating", controlsUnchanged: true, idleSplitIsolation: true }));
  } finally {
    await client.evaluate("document.getElementById('harness-test-idle-split')?.remove()");
  }
}

async function exerciseNarrowEnhancementStatus(client) {
  const { height, scale } = await client.evaluate("({ height: innerHeight, scale: devicePixelRatio })");
  await client.call("Emulation.setDeviceMetricsOverride", { width: 480, height, deviceScaleFactor: scale, mobile: false });
  try {
    const draft = "请优化这段草稿 HARNESS_RETURN_UNCHANGED";
    await setDraft(client, draft);
    await until(() => client.evaluate(`innerWidth === 480 && (${ACTIVE})?.getBoundingClientRect().right <= innerWidth`),
      "最窄窗口的输入框进入可视范围");
    await delay(300);
    const before = await enhancementStatusLayout(client);
    await threeSpaces(client);
    assert.equal(await enhancementStatus(client), "正在增强…");
    const waiting = await enhancementStatusLayout(client);
    assert.deepEqual(waiting.geometry, before.geometry, "最窄窗口的输入框和工具栏控件位置保持");
    assert.ok(waiting.focused && waiting.compact && waiting.slot && waiting.textFits, "最窄窗口完整显示等待提示");
    await until(async () => await enhancementStatus(client) === "增强完成，草稿未改动", "最窄窗口显示完成提示");
    const completed = await enhancementStatusLayout(client);
    assert.ok(completed.compact && completed.slot && completed.textFits, "最窄窗口完整显示完成提示");
    assert.equal(await readDraft(client), draft);
    await until(async () => await enhancementStatus(client) === "", "最窄窗口的完成提示自动消失");
    console.log(JSON.stringify({ enhancementStatus: "fully-visible", viewportWidth: 480, controlsUnchanged: true }));
  } finally {
    await client.call("Emulation.clearDeviceMetricsOverride");
  }
}

async function enter(client, type, text) {
  if (type === "text") return client.call("Input.insertText", { text });
  const keys = {
    space: { key: " ", code: "Space", text: " ", unmodifiedText: " ", windowsVirtualKeyCode: 32 },
    undo: { key: "z", code: "KeyZ", modifiers: 2, windowsVirtualKeyCode: 90 },
    selectAll: { key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 },
    backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
    escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  };
  const descriptor = keys[type];
  await client.call("Input.dispatchKeyEvent", { ...descriptor, type: "keyDown" });
  await client.call("Input.dispatchKeyEvent", { key: descriptor.key, code: descriptor.code, type: "keyUp" });
}

async function threeSpaces(client) {
  for (let index = 0; index < 3; index++) await enter(client, "space");
}

async function rate(client) {
  return client.evaluate(`(${RATE})?.textContent || ''`);
}

async function rateTitle(client) {
  return client.evaluate(`(${RATE})?.title || ''`);
}

async function isGenerating(client) {
  return client.evaluate(`!!document.querySelector('[data-testid="v4-stop"]')?.getClientRects().length`);
}

async function rateIsBeforeControls(client, contextRequired = true) {
  return client.evaluate(`(() => {
    const toolbar = (${ACTIVE})?.closest('.chat-composer-input-surface');
    const rate = toolbar?.querySelector('[data-testid="harness-generation-rate"]');
    const context = toolbar?.querySelector('[data-testid="chat-context-usage-trigger"]');
    const model = toolbar?.querySelector('[data-testid="chat-model-select-trigger"]');
    if (!rate || !model || (${contextRequired} && !context)) return false;
    const rateBox = rate.getBoundingClientRect();
    const controls = context ? [context, model] : [model];
    const centerY = (box) => box.top + box.height / 2;
    return rateBox.width > 0 && controls.every((control) => {
      const box = control.getBoundingClientRect();
      return rateBox.right <= box.left + .5 && Math.abs(centerY(rateBox) - centerY(box)) <= 2;
    });
  })()`);
}

async function click(client, testId) {
  return client.evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(`[data-testid="${testId}"]`)});
    if (!node || node.disabled || !node.getClientRects().length) return false;
    node.click();
    return true;
  })()`);
}

async function session(client) {
  return client.evaluate(`(${PANE})?.dataset.sessionId`);
}

async function showSession(client, id) {
  await until(() => click(client, `task-item-${id}`), `打开会话 ${id}`);
  await until(async () => await session(client) === id, `会话 ${id} 加载`);
}

async function focusDraft(client) {
  await until(() => client.evaluate(`(() => {
    const input = (${ACTIVE});
    if (!input?.isContentEditable || !input.__zcodeLexicalInputE2E) return false;
    input.focus({ preventScroll: true });
    return document.activeElement === input;
  })()`), "输入框获焦");
}

async function setDraft(client, text) {
  await focusDraft(client);
  await enter(client, "selectAll");
  await enter(client, "text", text);
  await until(async () => await readDraft(client) === text, "输入草稿");
}

async function startRateCase(client, prompt) {
  await setDraft(client, prompt);
  await until(() => click(client, "v4-composer-send"), "发送速率回归用例");
  return until(async () => {
    const value = await rate(client);
    return RATE_TEXT.test(value) && await isGenerating(client) && await rateTitle(client) === "生成中实时估算" && value;
  }, "回归用例生成中显示速率");
}

async function finishedRate(client, description) {
  const titles = [description].flat();
  const value = await until(async () => {
    const shown = await rate(client);
    return RATE_TEXT.test(shown) && !await isGenerating(client) && titles.includes(await rateTitle(client)) && shown;
  }, `回归用例结束后显示${titles.join("或")}`, 8500);
  assert.equal(await rateIsBeforeControls(client, false), true);
  return value;
}

async function checkUnloadedHistory(client, expectedRate) {
  const source = await fs.readFile(path.join(__dirname, "../src/rate.cjs"), "utf8");
  const { result, exceptionDetails } = await client.call("Runtime.evaluate", {
    awaitPromise: true,
    returnByValue: true,
    expression: `(async () => {
      const rate = (function () { const module = { exports: {} }; ${source}
        return { getComposerProps, getProjectionStore, readPreviousRate };
      })();
      const input = (${ACTIVE});
      const pane = input.closest('[data-session-pane-root][data-session-id]');
      const snapshot = rate.getComposerProps(input).snapshot;
      const latest = snapshot.rows.window.findLastIndex(row => row.kind === 'turnHeader');
      const tail = { ...snapshot, rows: { ...snapshot.rows, window: snapshot.rows.window.slice(latest) } };
      const store = rate.getProjectionStore(pane, tail);
      if (!store) return '未找到宿主会话历史接口';
      const value = await rate.readPreviousRate(store, tail, () => true);
      return value === null ? '' : value.toFixed(1) + ' tok/s';
    })()`,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
  assert.equal(result.value, expectedRate, "通过宿主只读接口恢复尾部窗口以外的均速");
}

async function exerciseRateFallback(client, originalSession, otherSession) {
  await sendTurn(client, "检查无实时估算与用量时的历史速率 HARNESS_NO_USAGE HARNESS_ONE_CHUNK");
  const previous = await finishedRate(client, "本会话最近均速（含等待）");
  await checkUnloadedHistory(client, previous);

  await until(() => click(client, "task-new-button"), "新建速率回归会话");
  await until(async () => await session(client) === "draft", "速率回归草稿");
  assert.equal(await rate(client), "", "新会话没有历史速率");
  await startRateCase(client, "检查首轮缺少用量时的速率 HARNESS_NO_USAGE HARNESS_PAUSE");
  const held = await until(async () => {
    const shown = await rate(client);
    return RATE_TEXT.test(shown) && await isGenerating(client) && await rateTitle(client) === "本轮最后一次实时估算" && shown;
  }, "停顿时保留最后一次实时读数");
  const estimated = await finishedRate(client, "本轮生成均速（估算）");
  const fallbackSession = await session(client);
  await showSession(client, otherSession);
  await until(async () => await rateTitle(client) === "本轮实际均速", "另一个会话的实际均速");
  await showSession(client, fallbackSession);
  await until(async () => await rate(client) === estimated &&
    await rateTitle(client) === "本轮生成均速（估算）", "切回后恢复本会话的估算");

  await startRateCase(client, "检查手动停止时的速率 HARNESS_INTERRUPT");
  await until(() => click(client, "v4-stop"), "手动停止生成");
  const interrupted = await finishedRate(client, ["本轮最后一次实时估算", "本轮生成均速（估算）"]);
  await delay(2200);
  assert.equal(await rate(client), interrupted, "结束后的估算应当保留");
  await showSession(client, originalSession);
  await until(async () => await rate(client) === previous &&
    await rateTitle(client) === "本会话最近均速（含等待）", "切回后恢复本会话的历史均速");
  console.log(JSON.stringify({ previous, held, estimated, interrupted }));
}

async function exerciseRateAfterRead(client, fixture) {
  await openNewDraft(client);
  const before = (await fixture.counts()).stream;
  const beforeRead = await startRateCase(client, "读取隔离测试文件并继续输出 HARNESS_RATE_READ");
  const afterRead = await until(async () => {
    const text = await rate(client);
    const responded = await client.evaluate(`(${PANE})?.textContent?.includes("读取后输出第 1 段。")`);
    return responded && RATE_TEXT.test(text) && await isGenerating(client) &&
      await rateTitle(client) === "生成中实时估算" && text;
  }, "只读工具返回后恢复实时速率");
  const final = await finishedRate(client, "本轮生成均速（估算）");
  assert.equal((await fixture.counts()).stream, before + 2, "工具前后各一次模型请求");
  console.log(JSON.stringify({ readTool: "fixture-file-only", beforeRead, afterRead, final }));
}

async function exerciseUnsentDrafts(client) {
  await until(() => click(client, "task-new-button"), "打开未发送草稿");
  await until(async () => await session(client) === "draft", "草稿会话");
  await setDraft(client, "请改写第一份未发送草稿");
  await threeSpaces(client);
  await until(() => click(client, "task-new-button"), "同项目新建另一份草稿");
  await until(async () => await readDraft(client) === "", "新的未发送草稿已清空");
  const otherDraft = "这份新草稿不能收到第一份草稿的结果";
  await setDraft(client, otherDraft);
  await delay(1450);
  assert.equal(await readDraft(client), otherDraft);

  await threeSpaces(client);
  await until(() => click(client, "v4-composer-send"), "增强返回前发送原稿");
  await until(async () => (await session(client)) !== "draft", "草稿成为正式会话");
  await until(async () => await readDraft(client) === `增强结果：${otherDraft}`, "正式会话接收原草稿的增强结果");
  await client.evaluate(`(${ACTIVE}).focus()`);
  await enter(client, "undo");
  await until(async () => await readDraft(client) === "", "发送后的增强可撤销为空草稿");
  console.log(JSON.stringify({ unsentDraftIsolation: "passed", unsentDraftHandoff: "passed" }));
}

async function fixtureForDebugPort(debugPort) {
  const root = path.join(os.tmpdir(), "harness-zcode-4-e2e");
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("run-")) continue;
    let probe;
    try {
      probe = JSON.parse(await fs.readFile(path.join(root, entry.name, "fixture.json"), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (probe.debugPort !== debugPort) continue;
    assert.ok(Number.isInteger(probe.mockPort) && probe.mockPort > 0, "隔离模型端口无效");
    const baseUrl = `http://127.0.0.1:${probe.mockPort}/fixture/`;
    const query = async (endpoint, method = "GET") => {
      const response = await fetch(baseUrl + endpoint, { method });
      assert.ok(response.ok, `读取隔离模型统计失败 ${endpoint}`);
      return response.json();
    };
    return {
      pid: probe.pid,
      executable: await fs.realpath(path.join(root, "app", "ZCode.exe")),
      counts: () => query("requests"), prompts: () => query("prompt-requests"),
      minimizedStream: () => query("minimized-stream"),
      finishMinimizedStream: () => query("minimized-stream", "POST"),
      releaseEnhancement: () => query("release-enhancement", "POST"),
    };
  }
  throw new Error(`找不到调试端口 ${debugPort} 对应的隔离夹具`);
}

async function openNewDraft(client) {
  await until(() => click(client, "task-new-button"), "打开预测用的新草稿");
  await until(async () => await session(client) === "draft" && await readDraft(client) === "", "预测用空白输入框");
}

async function sendTurn(client, prompt) {
  await setDraft(client, prompt);
  await until(() => click(client, "v4-composer-send"), "发送预测回归用例");
  await until(() => isGenerating(client), "预测回归用例开始生成");
}

async function waitForPrompt(fixture, matches, label) {
  return until(async () => (await fixture.prompts()).find(matches), label);
}

async function assertNoPromptRequests(fixture, before, label, categories = ["prediction"]) {
  await delay(1700);
  const after = await fixture.counts();
  for (const category of categories) {
    assert.equal(after[category], before[category], `${label}不应增加 ${category} 请求`);
  }
}

function fixtureReply(finalText) {
  return Array.from({ length: 18 }, (_, index) => `模拟输出第 ${index + 1} 段。`).join("") + finalText;
}

async function windowController(client, fixture) {
  try {
    const { windowId } = await client.call("Browser.getWindowForTarget", { targetId: client.targetId });
    assert.ok(Number.isInteger(windowId), "未取得隔离窗口 ID");
    return {
      backend: "CDP",
      setMinimized: (minimized) => client.call("Browser.setWindowBounds", { windowId, bounds: { windowState: minimized ? "minimized" : "normal" } }),
      isMinimized: async () => (await client.call("Browser.getWindowBounds", { windowId })).bounds.windowState === "minimized",
    };
  } catch (error) {
    if (process.platform !== "win32" || !/wasn't found|not supported|not implemented|no browser window/iu.test(error.message)) throw error;
  }

  // Electron 的 CDP 可能缺少 Browser 窗口命令。原生后备仍只操作隔离副本的窗口。
  assert.ok(Number.isInteger(fixture.pid) && fixture.pid > 0, "隔离进程 PID 无效");
  let handle = "";
  async function changeNativeWindow(action) {
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -Name NativeWindow -Namespace ZCodeFixture -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
'@
$target = Get-Process -Id ([int]$env:ZCODE_FIXTURE_PID)
if ((Get-Item -LiteralPath $target.Path).FullName -ne $env:ZCODE_FIXTURE_EXE) { throw 'The process is not the isolated ZCode fixture' }
$hWnd = if ($env:ZCODE_FIXTURE_HANDLE) { [IntPtr]::new([long]$env:ZCODE_FIXTURE_HANDLE) } else { $target.MainWindowHandle }
$owner = [uint32]0
[void][ZCodeFixture.NativeWindow]::GetWindowThreadProcessId($hWnd, [ref]$owner)
if ($owner -ne $target.Id) { throw 'The window does not belong to the isolated process' }
if ($env:ZCODE_FIXTURE_SHOW) {
  if (-not [ZCodeFixture.NativeWindow]::ShowWindowAsync($hWnd, [int]$env:ZCODE_FIXTURE_SHOW)) {
    throw 'Unable to change the isolated window state'
  }
}
@{ handle = $hWnd.ToInt64().ToString(); minimized = [ZCodeFixture.NativeWindow]::IsIconic($hWnd) } | ConvertTo-Json -Compress
`;
    const command = Buffer.from(script, "utf16le").toString("base64");
    const { stdout } = await runFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", command], {
      windowsHide: true, timeout: 10000,
      env: { ...process.env, ZCODE_FIXTURE_PID: String(fixture.pid), ZCODE_FIXTURE_EXE: fixture.executable,
        ZCODE_FIXTURE_HANDLE: handle, ZCODE_FIXTURE_SHOW: action },
    });
    const state = JSON.parse(stdout);
    handle = state.handle;
    return state.minimized;
  }
  await changeNativeWindow("");
  return {
    backend: "Win32",
    setMinimized: (minimized) => changeNativeWindow(minimized ? "6" : "9"),
    isMinimized: () => changeNativeWindow(""),
  };
}

async function exerciseWindowLifecycle(client, fixture) {
  const source = await fs.readFile(path.join(__dirname, "../src/rate.cjs"), "utf8");
  const latestState = () => client.evaluate(`(() => {
    const getProps = (function () { const module = { exports: {} }; ${source} ;return module.exports.getComposerProps; })();
    const input = (${PANE})?.querySelector('[data-testid="v4-composer-input"]');
    const rows = getProps(input)?.snapshot?.rows?.window ?? [];
    const headerIndex = rows.findLastIndex(row => row.kind === 'turnHeader');
    const header = rows[headerIndex];
    return { state: header?.state, key: header?.productTurnId || header?.turnId,
      hasOutput: rows.slice(headerIndex + 1).some(row => row.kind === 'assistantText' && row.text),
      hidden: document.visibilityState === 'hidden', focused: document.hasFocus() };
  })()`);
  const window = await windowController(client, fixture);
  await openNewDraft(client);
  await client.call("Emulation.setFocusEmulationEnabled", { enabled: false });
  await client.call("Page.bringToFront");
  await until(() => client.evaluate("document.hasFocus()"), "隔离窗口在前台");
  const before = await fixture.counts();
  const hiddenPrompt = "在窗口最小化期间生成 HARNESS_PREDICT_MINIMIZED";
  await sendTurn(client, hiddenPrompt);
  const originalTurn = await until(async () => {
    const state = await latestState();
    return state.focused && state.state === "running" && state.hasOutput && state.key;
  }, "最小化前已观察到同一轮产生输出");
  const origin = await session(client);
  await window.setMinimized(true);
  try {
    await until(() => window.isMinimized(), "原生隔离窗口已最小化");
    await until(() => client.evaluate("document.visibilityState === 'hidden' && !document.hasFocus()"), "渲染器已隐藏并失焦");
    await until(async () => (await fixture.minimizedStream()).phase === "waiting", "模拟服务等待窗口最小化");
    await fixture.finishMinimizedStream();
    await until(async () => (await fixture.minimizedStream()).phase === "returned", "模拟服务在最小化时结束流");
    await until(async () => {
      const state = await latestState();
      return state.hidden && !state.focused && state.key === originalTurn && state.state === "completedSuccess";
    }, "宿主在窗口最小化期间提交成功状态");
    assert.equal(await window.isMinimized(), true, "整轮完成时窗口仍处于最小化状态");
    assert.equal((await fixture.counts()).prediction, before.prediction, "隐藏期间不应请求预测");
  } finally {
    await window.setMinimized(false);
    await client.call("Page.bringToFront");
  }

  await until(() => client.evaluate("document.visibilityState === 'visible' && document.hasFocus()"), "隔离窗口恢复前台");
  assert.equal(await session(client), origin);
  assert.equal(await readDraft(client), "");
  await assertNoPromptRequests(fixture, before, "恢复已在后台完成的会话时");

  // 隔离窗口已经实际恢复。接下来的正向用例固定焦点，避免用户同时操作其他应用影响结果。
  await client.call("Emulation.setFocusEmulationEnabled", { enabled: true });
  const foregroundPrompt = "恢复后在同一会话前台生成 HARNESS_PREDICT_RESTORED";
  await sendTurn(client, foregroundPrompt);
  assert.equal(await client.evaluate("document.hasFocus()"), true, "生成中隔离页面保持受控焦点");
  await waitForPrompt(fixture, (request) => request.kind === "prediction" && request.previousUser === foregroundPrompt && request.returned,
    "恢复后同一会话前台的新成功回合仍生成候选");
  assert.equal(await client.evaluate("document.hasFocus()"), true, "生成后隔离页面保持受控焦点");
  assert.equal(await session(client), origin);
  await focusDraft(client);
  await threeSpaces(client);
  await until(async () => await readDraft(client) === "继续说明恢复前台后的下一步。", "恢复前台后可采纳新候选");
  await enter(client, "undo");
  await until(async () => await readDraft(client) === "", "撤销恢复前台后的新候选");
  assert.equal((await fixture.counts()).prediction, before.prediction + 1);
  console.log(JSON.stringify({ windowController: window.backend, minimizedCompletion: "no-prediction",
    foregroundCompletion: "prediction-accepted", foregroundFocus: "emulated-after-native-restore" }));
}

async function exercisePredictions(client, fixture) {
  await openNewDraft(client);
  const beforeFirst = await fixture.counts();
  const firstPrompt = "生成会话甲的预测验收正文 HARNESS_PREDICT_ACCEPT";
  const firstReply = fixtureReply("会话甲的独有最终正文。");
  const firstSuggestion = "继续说明会话甲的下一步。";
  await sendTurn(client, firstPrompt);
  await finishedRate(client, "本轮实际均速");
  const origin = await session(client);
  assert.ok(origin && origin !== "draft");
  const predictionFor = (prompt) => (request) => request.kind === "prediction" && request.previousUser === prompt;
  const started = await waitForPrompt(fixture, predictionFor(firstPrompt), "空输入框自动预测");
  assert.equal(started.draft, null);
  assert.equal(started.previousReply, firstReply, "预测上下文必须是本轮最终正文");
  assert.equal(await readDraft(client), "", "发起预测时保持空输入框");
  await waitForPrompt(fixture, (request) => predictionFor(firstPrompt)(request) && request.returned, "预测结果已到达");
  await until(() => client.evaluate(`(${PREVIEW})?.textContent === ${JSON.stringify(firstSuggestion)}`), "候选就绪后直接显示灰字");
  const previewLayout = await client.evaluate(`(() => {
    const input = (${ACTIVE}), preview = (${PREVIEW}), placeholder = input.nextElementSibling;
    const anchor = input.getBoundingClientRect(), box = preview.getBoundingClientRect();
    return !input.contains(preview) && preview.getAttribute("aria-hidden") === "true" &&
      getComputedStyle(preview).pointerEvents === "none" && getComputedStyle(placeholder).visibility === "hidden" &&
      Math.abs(anchor.left - box.left) < 1 && Math.abs(anchor.top - box.top) < 1 &&
      box.right <= anchor.right + 1 && box.bottom <= anchor.bottom + 1;
  })()`);
  assert.equal(previewLayout, true, "灰字与宿主输入区域对齐，不占用正文或阻挡键入");
  const beforeAccept = await fixture.counts();
  assert.equal(beforeAccept.prediction, beforeFirst.prediction + 1, "同一次新回合只发起一次预测");
  assert.equal(await readDraft(client), "", "预测结果到达时仍保持空输入框");

  await focusDraft(client);
  await enter(client, "text", "先试着输入自己的草稿");
  await until(() => client.evaluate(`!(${PREVIEW})`), "手工输入时隐藏灰字预览");
  await enter(client, "selectAll");
  await enter(client, "backspace");
  await until(() => client.evaluate(`(${PREVIEW})?.textContent === ${JSON.stringify(firstSuggestion)}`), "清空后显示同一候选");
  await threeSpaces(client);
  await until(async () => await readDraft(client) === firstSuggestion, "空框三击接受已缓存的预测");
  assert.equal(await enhancementStatus(client), "");
  assert.equal(await client.evaluate(`!(${PREVIEW})`), true);
  await enter(client, "undo");
  await until(async () => await readDraft(client) === "", "接受预测后一次 Ctrl+Z 回到空输入框");
  assert.equal(await client.evaluate(`!(${PREVIEW})`), true, "撤销不恢复已经采纳的预览");
  await assertNoPromptRequests(fixture, beforeAccept, "接受及撤销预测时", ["prediction", "enhancement", "stream"]);
  console.log(JSON.stringify({ prediction: "requested-once", preview: "visible-before-gesture", noAutoFill: true, acceptWithoutRequest: true, undoToEmpty: true }));

  const unchangedDraft = "请检查上一条答复 HARNESS_RETURN_UNCHANGED";
  const added = "，这段是等待期间补写的。";
  const manualForDraft = (request) => request.kind === "enhancement" && request.draft === unchangedDraft;
  await setDraft(client, unchangedDraft);
  await threeSpaces(client);
  assert.equal(await enhancementStatus(client), "正在增强…");
  const manual = await waitForPrompt(fixture, manualForDraft, "有文字三击发起上下文增强");
  assert.equal(manual.previousReply, firstReply, "改写请求携带同一会话的最近最终正文");
  assert.equal(manual.previousUser, null, "主动改写不携带上一轮用户消息");
  await enter(client, "text", added);
  await waitForPrompt(fixture, (request) => manualForDraft(request) && request.returned, "原文增强已返回");
  await until(async () => await enhancementStatus(client) === "增强完成，草稿未改动", "原文返回的完成提示");
  await until(async () => await enhancementStatus(client) === "", "原文返回提示自动消失");
  await delay(400);
  assert.equal(await readDraft(client), unchangedDraft + added, "原样返回不覆盖等待期间的输入");
  console.log(JSON.stringify({ contextualEnhancement: "same-session-final-reply", unchangedResultPreservedNewTyping: true }));

  await sendTurn(client, "验证有草稿时不预热 HARNESS_PREDICT_NONEMPTY");
  const beforeNonempty = await fixture.counts();
  const inProgressDraft = "成功结束时这里已有未发送文字。";
  await setDraft(client, inProgressDraft);
  await finishedRate(client, "本轮实际均速");
  await assertNoPromptRequests(fixture, beforeNonempty, "成功结束时输入框非空");
  assert.equal(await readDraft(client), inProgressDraft);

  const switchPrompt = "生成切换前不接受的候选 HARNESS_PREDICT_SWITCH";
  await sendTurn(client, switchPrompt);
  await finishedRate(client, "本轮实际均速");
  await waitForPrompt(fixture, (request) => predictionFor(switchPrompt)(request) && request.returned, "原会话未采用候选已到达");
  assert.equal(await readDraft(client), "");
  await openNewDraft(client);
  await startRateCase(client, "验证手动中断不预热 HARNESS_INTERRUPT");
  const other = await session(client);
  assert.ok(other && other !== "draft" && other !== origin);
  const beforeInterrupt = await fixture.counts();
  await until(() => click(client, "v4-stop"), "停止预测回归的中断回合");
  await finishedRate(client, ["本轮最后一次实时估算", "本轮生成均速（估算）"]);
  await assertNoPromptRequests(fixture, beforeInterrupt, "手动中断回合后");
  await focusDraft(client);
  await threeSpaces(client);
  assert.equal((await readDraft(client)).trim(), "", "另一会话不能采用原会话未接受的候选");

  const beforeReturn = await fixture.counts();
  await showSession(client, origin);
  await focusDraft(client);
  await threeSpaces(client);
  await assertNoPromptRequests(fixture, beforeReturn, "切回已有历史的原会话时", ["prediction", "enhancement"]);
  assert.equal((await readDraft(client)).trim(), "", "切回原会话后旧候选也已失效");
  console.log(JSON.stringify({ nonempty: "no-prediction", interrupted: "no-prediction", switchedCandidate: "invalidated" }));

  if (await readDraft(client)) {
    await enter(client, "selectAll");
    await enter(client, "backspace");
    await until(async () => await readDraft(client) === "", "重新加载前原会话输入框为空");
  }
  const beforeReload = await fixture.counts();
  const oldTime = await client.evaluate("performance.timeOrigin");
  await client.call("Page.reload", { ignoreCache: true });
  await until(async () => {
    try {
      return await client.evaluate(`performance.timeOrigin !== ${oldTime} && !!window.__harnessZCode && !!(${ACTIVE})?.__zcodeLexicalInputE2E`);
    } catch {
      return false;
    }
  }, "重新加载隔离客户端并恢复扩展", 45000);
  if (await session(client) !== origin) await showSession(client, origin);
  await assertNoPromptRequests(fixture, beforeReload, "扩展首次打开已有回合历史时");
  assert.equal(await readDraft(client), "");
  console.log(JSON.stringify({ startupHistory: "no-prediction" }));
}

async function exercise(client, screenshot, fixture) {
  await until(() => client.evaluate("!!window.__harnessZCode"), "扩展加载");
  await client.call("Emulation.setFocusEmulationEnabled", { enabled: true });
  await until(async () => {
    if (await client.evaluate(`!!(${ACTIVE})?.__zcodeLexicalInputE2E`)) return true;
    await click(client, "login-use-api-key-button");
    await click(client, "login-api-key-skip-button");
    if (await client.evaluate(`!!document.querySelector('[data-testid="onboarding-page"]')`)) {
      await enter(client, "escape");
    }
    return false;
  }, "ZCode 输入框", 45000);
  if (await session(client) !== "draft") {
    await until(() => click(client, "task-new-button"), "新建速率测试会话");
    await until(async () => await session(client) === "draft", "打开空白草稿");
  }
  await until(() => client.evaluate(`!!(${ACTIVE})?.__zcodeLexicalInputE2E`), "ZCode 输入框");
  await client.call("Page.bringToFront");
  await client.evaluate(`(${ACTIVE}).focus()`);
  assert.equal(await rate(client), "");

  await enter(client, "text", "请检查首包和尾包等待不影响速率 HARNESS_SLOW_FIRST HARNESS_SLOW_TAIL");
  await until(() => click(client, "v4-composer-send"), "发送速率测试");
  const live = await until(async () => {
    const value = await rate(client);
    return RATE_TEXT.test(value) && await isGenerating(client) && value;
  }, "生成中显示纯数值速率");
  assert.equal(await rateIsBeforeControls(client, false), true);
  const final = await until(async () => {
    const value = await rate(client);
    return RATE_TEXT.test(value) && !await isGenerating(client) && await rateTitle(client) === "本轮实际均速" && value;
  }, "生成结束实际速率");
  assert.ok(parseFloat(final) > 45 && parseFloat(final) < 65,
    `等首包约 2.8 秒、等尾包约 1.1 秒后，130 个输出词元仍只除以约 2.3 秒生成时长，实际 ${final}`);
  assert.equal(await rateIsBeforeControls(client), true);
  console.log(JSON.stringify({ live, final, position: "left-of-context-and-model" }));

  const original = "帮我优化这份草稿";
  await client.evaluate(`(${ACTIVE}).focus()`);
  await enter(client, "text", original);
  await enter(client, "space");
  await delay(730);
  assert.equal(await readDraft(client), original + " ");
  const layoutBefore = await enhancementStatusLayout(client);
  assert.equal(await enhancementStatus(client), "");
  await threeSpaces(client);
  assert.equal(await enhancementStatus(client), "正在增强…");
  const layoutDuring = await enhancementStatusLayout(client);
  assert.deepEqual(layoutDuring.geometry, layoutBefore.geometry, "提示出现时工具栏、正文和按钮位置均保持");
  assert.ok(layoutDuring.slot && layoutDuring.textFits, "提示位于工具栏预留空间且全文可见");
  assert.equal(layoutDuring.focused, true);
  assert.equal(layoutDuring.role, "status");
  assert.equal(layoutDuring.pointerEvents, "none");
  const added = "，保留这条等待期间的补充";
  await enter(client, "text", added);
  const expectedUndo = original + " " + added;
  const enhanced = await until(async () => {
    const value = await readDraft(client);
    return typeof value === "string" && value.startsWith("增强结果：") && value;
  }, "三击空格回填");
  assert.ok(enhanced.includes(original));
  await until(async () => await enhancementStatus(client) === "", "回填后等待提示消失");
  if (screenshot) {
    const capture = await client.call("Page.captureScreenshot", { format: "png" });
    await fs.writeFile(screenshot, Buffer.from(capture.data, "base64"));
  }
  await enter(client, "undo");
  await until(async () => (await readDraft(client)) === expectedUndo, "Ctrl+Z 恢复回填前文本");
  console.log(JSON.stringify({ enhanced, undo: await readDraft(client), regularSpace: "preserved" }));

  const originalSession = await session(client);
  await until(() => click(client, "task-new-button"), "新建会话");
  await until(async () => await session(client) === "draft", "新会话输入框");
  await setDraft(client, "创建第二个隔离测试会话");
  await until(() => click(client, "v4-composer-send"), "发送第二个会话");
  const otherSession = await until(async () => {
    const id = await session(client);
    return id && id !== "draft" && id !== originalSession && id;
  }, "第二个会话 ID");
  await until(async () => RATE_TEXT.test(await rate(client)) && !await isGenerating(client), "第二个会话生成完成");
  const otherDraft = "其他会话的草稿应当保持不变";
  await setDraft(client, otherDraft);
  await showSession(client, originalSession);
  const sourceDraft = "请增强原会话的草稿 HARNESS_HOLD_ENHANCEMENT";
  await setDraft(client, sourceDraft);
  await threeSpaces(client);
  assert.equal(await enhancementStatus(client), "正在增强…");
  await showSession(client, otherSession);
  assert.equal(await readDraft(client), otherDraft);
  assert.equal(await enhancementStatus(client), "");
  await showSession(client, originalSession);
  await until(async () => await enhancementStatus(client) === "正在增强…", "切回仍在等待的原草稿");
  await waitForPrompt(fixture, (request) => request.kind === "enhancement" && request.draft === sourceDraft,
    "隔离模型已收到原草稿");
  await showSession(client, otherSession);
  assert.equal(await enhancementStatus(client), "");
  await fixture.releaseEnhancement();
  await waitForPrompt(fixture, (request) => request.kind === "enhancement" && request.draft === sourceDraft && request.returned,
    "隔离模型已返回原草稿结果");
  assert.equal(await readDraft(client), otherDraft);
  await showSession(client, originalSession);
  await until(async () => (await readDraft(client))?.startsWith("增强结果："), "结果回填到原会话");
  await client.evaluate(`(${ACTIVE}).focus()`);
  await enter(client, "undo");
  await until(async () => await readDraft(client) === sourceDraft, "切回原会话后 Ctrl+Z");
  console.log(JSON.stringify({ switched: "original-session-only", undoAfterSwitch: await readDraft(client) }));

  const protectedDraft = "运行 `npm test -- --watch=false` 检查回归。";
  await setDraft(client, protectedDraft);
  await threeSpaces(client);
  await until(() => client.evaluate(`document.querySelector('[data-testid="harness-enhancement-notice"]')?.textContent.includes('关键内容')`),
    "增强结果漏掉命令参数时提示");
  await until(async () => await enhancementStatus(client) === "", "失败后等待提示消失");
  assert.equal(await readDraft(client), protectedDraft);
  console.log(JSON.stringify({ alteredCommand: "blocked", draft: await readDraft(client) }));

  await exerciseRateFallback(client, originalSession, otherSession);
  await exerciseRateAfterRead(client, fixture);
  await exerciseUnsentDrafts(client);
  await exerciseWindowLifecycle(client, fixture);
  await exercisePredictions(client, fixture);
  await exerciseNarrowEnhancementStatus(client);
  await exerciseFloatingEnhancementStatus(client);
}

if (require.main === module) {
  const port = Number(process.argv[2]);
  fixtureForDebugPort(port).then(async (fixture) => {
    const client = await connect(port);
    try {
      await exercise(client, process.argv[3], fixture);
    } finally {
      client.close();
    }
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { connect, enter, readDraft, rate, until };
