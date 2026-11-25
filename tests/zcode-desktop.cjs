"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { setTimeout: delay } = require("node:timers/promises");

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
  return { call, evaluate, close: () => socket.close() };
}

const ACTIVE = `Array.from(document.querySelectorAll('[data-testid="v4-composer-input"]')).find(element => element.getClientRects().length)`;
const PANE = `document.querySelector('[data-testid="v4-session-pane-workspace-main"]')`;
const RATE_TEXT = /^\d+(?:\.\d+)? tok\/s$/u;

async function readDraft(client) {
  return client.evaluate(`(${ACTIVE})?.__zcodeLexicalInputE2E?.getText()`);
}

async function enter(client, type, text) {
  if (type === "text") return client.call("Input.insertText", { text });
  const keys = {
    space: { key: " ", code: "Space", text: " ", unmodifiedText: " ", windowsVirtualKeyCode: 32 },
    undo: { key: "z", code: "KeyZ", modifiers: 2, windowsVirtualKeyCode: 90 },
    selectAll: { key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 },
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
  return client.evaluate(`document.querySelector('[data-testid="harness-generation-rate"]')?.textContent || ''`);
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

async function setDraft(client, text) {
  await client.evaluate(`(${ACTIVE}).focus()`);
  await enter(client, "selectAll");
  await enter(client, "text", text);
  await until(async () => await readDraft(client) === text, "输入草稿");
}

async function exercise(client, screenshot) {
  await until(() => client.evaluate("!!window.__harnessZCode"), "扩展加载");
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

  await enter(client, "text", "请检查首版的速率显示");
  await until(() => click(client, "v4-composer-send"), "发送速率测试");
  const live = await until(async () => {
    const value = await rate(client);
    return RATE_TEXT.test(value) && await isGenerating(client) && value;
  }, "生成中显示纯数值速率");
  assert.equal(await rateIsBeforeControls(client, false), true);
  const final = await until(async () => {
    const value = await rate(client);
    return RATE_TEXT.test(value) && !await isGenerating(client) && value;
  }, "生成结束实际速率");
  assert.equal(await rateIsBeforeControls(client), true);
  console.log(JSON.stringify({ live, final, position: "left-of-context-and-model" }));

  const original = "帮我优化这份草稿";
  await client.evaluate(`(${ACTIVE}).focus()`);
  await enter(client, "text", original);
  await enter(client, "space");
  await delay(730);
  assert.equal(await readDraft(client), original + " ");
  await threeSpaces(client);
  const added = "，保留这条等待期间的补充";
  await enter(client, "text", added);
  const expectedUndo = original + " " + added;
  const enhanced = await until(async () => {
    const value = await readDraft(client);
    return typeof value === "string" && value.startsWith("增强结果：") && value;
  }, "三击空格回填");
  assert.ok(enhanced.includes(original));
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
  const sourceDraft = "请增强原会话的草稿";
  await setDraft(client, sourceDraft);
  await threeSpaces(client);
  await showSession(client, otherSession);
  assert.equal(await readDraft(client), otherDraft);
  await delay(1700);
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
  assert.equal(await readDraft(client), protectedDraft);
  console.log(JSON.stringify({ alteredCommand: "blocked", draft: await readDraft(client) }));
}

if (require.main === module) {
  connect(Number(process.argv[2])).then(async (client) => {
    try {
      await exercise(client, process.argv[3]);
    } finally {
      client.close();
    }
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { connect, enter, readDraft, rate, until };
