"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { installEnhancement } = require("../src/enhancement.cjs");
const replyContext = require("../src/reply-context.cjs");

const model = { providerId: "fixture-provider", modelId: "fixture-model" };
const rootScope = "fixture-project";

function draftToken(generation) {
  return Symbol(JSON.stringify(["fixture-workspace", "__draft__", generation, rootScope]));
}

function createFixture() {
  const listeners = new Map();
  const windowListeners = new Map();
  const frames = new Map();
  const timers = new Map();
  const observers = new Set();
  const requests = [];
  const notices = [];
  const writes = [];
  let clock = 0;
  let nextJob = 0;
  let view;
  let previewNode;

  function changed() {
    for (const notify of observers) notify();
  }

  const document = {
    documentElement: {},
    head: { append() {} },
    hasFocus: () => view.foreground,
    get visibilityState() { return view.visibilityState; },
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name) { listeners.delete(name); },
    querySelectorAll(selector) {
      if (selector === ".harness-enhancement-status-slot") return toolbar.slot ? [toolbar.slot] : [];
      return view ? [input] : [];
    },
    createElement() {
      return {
        dataset: {}, style: {}, textContent: "", setAttribute() {},
        append(child) { this.child = child; },
        querySelector() { return this.child; },
        remove() {
          this.nextElementSibling = null;
          if (toolbar.slot === this) toolbar.slot = null;
        },
      };
    },
  };
  const window = {
    document,
    AbortController,
    addEventListener(name, callback) { windowListeners.set(name, callback); },
    removeEventListener(name) { windowListeners.delete(name); },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe() { observers.add(this.callback); }
      disconnect() { observers.delete(this.callback); }
    },
    getSelection() {
      return {
        rangeCount: 1, isCollapsed: true, focusNode: input,
        getRangeAt: () => ({ cloneRange: () => ({ setEnd() {}, toString: () => "" }) }),
      };
    },
    setTimeout(callback, ms) { timers.set(++nextJob, { callback, ms }); return nextJob; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(callback) { frames.set(++nextJob, callback); return nextJob; },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  const toolbar = {
    slot: null,
    querySelector() { return this.slot?.child; },
    append(slot) { this.slot = slot; slot.parentElement = this; changed(); },
  };
  const composer = {
    append(notice) { notices.push(notice.textContent); changed(); },
    querySelector(selector) {
      if (selector === "[data-composer-leading-actions]") return toolbar;
      return view.attachment && selector.includes(view.attachment) ? {} : null;
    },
  };
  const input = {
    get isConnected() { return !!view; }, childNodes: [],
    before(element) { previewNode = element; element.nextElementSibling = this; },
    closest(selector) {
      if (selector.includes("v4-composer-input")) return this;
      if (selector === '[data-testid="v4-composer"]') return composer;
      return null;
    },
    getClientRects() { return view ? [{}] : []; },
    contains(node) { return node === this; },
    __lexicalEditor: {
      getRootElement: () => input, isComposing: () => false,
      update(callback, { tag }) { callback(); writes.push({ text: view.text, tag }); changed(); },
    },
    __zcodeLexicalInputE2E: {
      getText: () => view.text, setText(text) { view.text = text; },
      getEditorState: () => ({}),
    },
  };
  document.activeElement = input;
  const composerSurface = {
    querySelector: () => input,
    closest: () => ({ getAttribute: () => view.props.sessionId || "draft" }),
  };

  const enhancement = installEnhancement({
    window, document, getComposerProps: () => view?.props, replyContext,
    request(payload, { signal } = {}) {
      const response = Promise.withResolvers();
      requests.push({ payload, signal, resolve: response.resolve });
      return response.promise;
    },
  });

  function paint() {
    let count = 0;
    while (frames.size) {
      assert.ok(count++ < 12, "写回应在有限帧内完成或等待界面变化");
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback();
    }
  }

  return {
    requests, notices, writes,
    get text() { return view.text; },
    get preview() { return previewNode?.nextElementSibling ? previewNode.textContent : ""; },
    get status() { return toolbar.slot?.child.textContent || ""; },
    get hasStatusRegion() { return !!toolbar.slot; },
    get retries() { return [...timers.values()].filter(({ ms }) => ms === 150).length; },
    expireStatus() {
      const entries = [...timers.values()].filter(({ ms }) => ms === 1500);
      assert.equal(entries.length, 1);
      entries[0].callback();
      paint();
    },
    dispose: enhancement.dispose,
    show({ sessionId = null, token = Symbol("session"), text, attachment = null, foreground = true,
      visibilityState = "visible", paintComposer = true, ...overrides }) {
      view = {
        text, attachment, foreground, visibilityState,
        props: {
          workspacePath: "fixture-workspace", rootDraftScopeKey: rootScope,
          sessionId, composerDraftScopeToken: token,
          createSubmissionFromComposer: () => ({ modelSelection: model }), ...overrides,
        },
      };
      if (paintComposer) enhancement.observeComposer(composerSurface, view.props);
      changed();
      paint();
    },
    suspendWindow(event) {
      view.foreground = false;
      if (event === "visibilitychange") {
        view.visibilityState = "hidden";
        listeners.get(event)();
      } else {
        windowListeners.get("blur")();
      }
    },
    resumeWindow(event) {
      view.foreground = true;
      view.visibilityState = "visible";
      if (event === "visibilitychange") listeners.get(event)?.();
      else windowListeners.get("focus")?.();
    },
    type(text) { view.text += text; changed(); },
    edit(text) {
      view.text = text;
      listeners.get("input")?.();
      paint();
    },
    strike() {
      const event = {
        target: input, key: " ", isTrusted: true, timeStamp: (clock += 70),
        defaultPrevented: false, preventDefault() { this.defaultPrevented = true; },
        stopImmediatePropagation() {},
      };
      listeners.get("keydown")(event);
      if (!event.defaultPrevented) view.text += " ";
    },
    threeSpaces() { for (let index = 0; index < 3; index++) this.strike(); },
    async settle(index, result) {
      requests[index].resolve(result);
      await Promise.resolve();
      paint();
    },
    finish(index, text) { return this.settle(index, { ok: true, text }); },
  };
}

test("同项目新建草稿后，原草稿的增强结果不覆盖现有输入", async () => {
  const app = createFixture();
  app.show({ token: draftToken(1), text: "原草稿" });
  app.threeSpaces();
  app.show({ token: draftToken(2), text: "新草稿" });
  await app.finish(0, "原草稿的增强结果");
  assert.equal(app.text, "新草稿");
  app.threeSpaces();
  assert.equal(app.requests[1].payload.text, "新草稿");
});

test("同一未发送草稿重新挂载时，仍可安全接收回填", async () => {
  const app = createFixture();
  app.show({ token: draftToken(1), text: "原草稿" });
  app.threeSpaces();
  app.show({ sessionId: "other", text: "其他会话" });
  await app.finish(0, "原草稿的增强结果");
  app.show({ token: draftToken(1), text: "原草稿" });
  assert.equal(app.text, "原草稿的增强结果");
});

test("草稿直接成为正式会话，仍可用同一草稿标识回填", async () => {
  const app = createFixture();
  const token = draftToken(1);
  app.show({ token, text: "等待提交的草稿" });
  app.threeSpaces();
  app.show({ sessionId: "promoted", token, text: "" });
  await app.finish(0, "已提交草稿的增强结果");
  assert.equal(app.text, "已提交草稿的增强结果");
});

test("同一草稿重新挂载后完成首发，切回正式会话仍可回填", async () => {
  const app = createFixture();
  app.show({ token: draftToken(1), text: "等待提交的草稿" });
  app.threeSpaces();
  const remountedToken = draftToken(1);
  app.show({ token: remountedToken, text: "等待提交的草稿" });
  app.show({ sessionId: "promoted", token: remountedToken, text: "" });
  app.show({ sessionId: "other", text: "其他会话的草稿" });
  await app.finish(0, "已提交草稿的增强结果");
  assert.equal(app.text, "其他会话的草稿");
  app.show({ sessionId: "promoted", text: "" });
  assert.equal(app.text, "已提交草稿的增强结果");
});

test("由新草稿复用的预热会话不能接收旧草稿的增强结果", async () => {
  const app = createFixture();
  app.show({ token: draftToken(1), text: "原草稿", skillCatalogSessionId: "prewarmed" });
  app.threeSpaces();
  const newToken = draftToken(2);
  app.show({ token: newToken, text: "新草稿", skillCatalogSessionId: "prewarmed" });
  app.show({ sessionId: "prewarmed", token: newToken, text: "新会话的草稿" });
  await app.finish(0, "原草稿的增强结果");
  assert.equal(app.text, "新会话的草稿");
});

test("其他会话的待回填结果不阻塞增强，离开期间也不轮询", async () => {
  const app = createFixture();
  app.show({ sessionId: "original", text: "原会话的草稿" });
  app.threeSpaces();
  app.show({ sessionId: "other", text: "另一会话的草稿" });
  await app.finish(0, "原会话增强结果");
  assert.equal(app.retries, 0);
  app.threeSpaces();
  assert.equal(app.requests[1].payload.text, "另一会话的草稿");
  await app.finish(1, "另一会话增强结果");
  assert.equal(app.text, "另一会话增强结果");
  app.show({ sessionId: "original", text: "原会话的草稿" });
  assert.equal(app.text, "原会话增强结果");
});

test("同一草稿仍在等待增强时，三次空格保留原生输入", async () => {
  const app = createFixture();
  app.show({ sessionId: "original", text: "待增强草稿" });
  app.threeSpaces();
  assert.equal(app.status, "正在增强…");
  app.threeSpaces();
  assert.equal(app.requests.length, 1);
  assert.equal(app.text, "待增强草稿   ");
});

test("增强提示立即显示，跟随原草稿并在回填后消失", async () => {
  const app = createFixture();
  app.show({ token: draftToken(1), text: "原草稿" });
  app.strike();
  app.strike();
  assert.equal(app.status, "");
  app.strike();
  assert.equal(app.status, "正在增强…");
  app.show({ token: draftToken(2), text: "新草稿" });
  assert.equal(app.status, "");
  app.show({ token: draftToken(1), text: "原草稿", paintComposer: false });
  assert.equal(app.status, "正在增强…");
  await app.finish(0, "改写后的原草稿");
  assert.equal(app.text, "改写后的原草稿");
  assert.equal(app.status, "");
});

test("模型返回后暂时不能写入时，等待提示持续到草稿实际回填", async () => {
  const app = createFixture();
  app.show({ sessionId: "original", text: "原草稿" });
  app.threeSpaces();
  app.show({ sessionId: "original", text: "原草稿", disabled: true });
  await app.finish(0, "改写后的原草稿");
  assert.equal(app.text, "原草稿");
  assert.equal(app.status, "正在增强…");
  app.show({ sessionId: "original", text: "原草稿" });
  assert.equal(app.text, "改写后的原草稿");
  assert.equal(app.status, "");
});

test("会话切换后，完成和超时提示均留在各自草稿", async () => {
  const app = createFixture();
  app.show({ sessionId: "original", text: "原草稿" });
  app.threeSpaces();
  app.show({ sessionId: "other", text: "另一份草稿" });
  app.threeSpaces();
  await app.finish(0, "原草稿");
  assert.equal(app.status, "正在增强…");
  app.show({ sessionId: "original", text: "原草稿" });
  assert.equal(app.status, "增强完成，草稿未改动");
  const timeout = "提示词增强超时，已保留草稿";
  await app.settle(1, { ok: false, error: timeout });
  assert.equal(app.status, "增强完成，草稿未改动");
  assert.deepEqual(app.notices, []);
  app.expireStatus();
  assert.equal(app.status, "");
  app.show({ sessionId: "other", text: "另一份草稿" });
  app.threeSpaces();
  await app.settle(2, { ok: false, error: timeout });
  assert.equal(app.status, "");
  assert.deepEqual(app.notices, [timeout]);
  assert.equal(app.text, "另一份草稿");
});

test("原样返回后的立即重试清除旧提示，卸载时移除提示", async () => {
  const app = createFixture();
  app.show({ sessionId: "original", text: "原草稿" });
  app.threeSpaces();
  await app.finish(0, "原草稿");
  assert.equal(app.status, "增强完成，草稿未改动");
  app.threeSpaces();
  assert.equal(app.status, "正在增强…");
  await app.finish(1, "改写后的草稿");
  assert.equal(app.status, "");
  app.threeSpaces();
  app.dispose();
  await app.finish(2, "卸载后忽略的结果");
  app.show({ sessionId: "other", text: "另一份草稿" });
  assert.equal(app.hasStatusRegion, false);
  assert.equal(app.status, "");
  assert.equal(app.writes.at(-1).text, "改写后的草稿");
});

test("同时增强不同草稿时，分别接收对应的结果", async () => {
  const app = createFixture();
  app.show({ sessionId: "original", text: "原会话的草稿" });
  app.threeSpaces();
  app.show({ sessionId: "other", text: "另一会话的草稿" });
  app.threeSpaces();
  assert.equal(app.requests.length, 2);
  await app.finish(1, "另一会话增强结果");
  await app.finish(0, "原会话增强结果");
  assert.equal(app.text, "另一会话增强结果");
  app.show({ sessionId: "original", text: "原会话的草稿" });
  assert.equal(app.text, "原会话增强结果");
});

test("宿主拒绝当前模型时，旧选择不能用于发送草稿", () => {
  const app = createFixture();
  app.show({
    sessionId: "original", text: "草稿", composerDraft: { modelSelection: model },
    createSubmissionFromComposer: () => null,
  });
  app.threeSpaces();
  assert.equal(app.requests.length, 0);
  assert.equal(app.text, "草稿   ");
  assert.match(app.notices.at(-1), /选择模型/);
});

for (const attachment of ["data-composer-context-attachments-row", "data-composer-element-screenshots"]) {
  test(`上下文附件 ${attachment} 阻止提示词增强`, () => {
    const app = createFixture();
    app.show({ text: "带有上下文附件的草稿", attachment });
    app.threeSpaces();
    assert.equal(app.requests.length, 0);
    assert.equal(app.text, "带有上下文附件的草稿   ");
    assert.match(app.notices.at(-1), /引用或附件/);
  });
}

test("等待期间新增附件会推迟写回，移除附件后恢复", async () => {
  const app = createFixture();
  app.show({ sessionId: "original", text: "草稿" });
  app.threeSpaces();
  app.show({ sessionId: "original", text: "草稿", attachment: "data-composer-context-attachments-row" });
  assert.equal(app.status, "正在增强…");
  await app.finish(0, "增强结果");
  assert.equal(app.text, "草稿");
  assert.equal(app.status, "");
  assert.match(app.notices.at(-1), /移除后将回填增强结果/u);
  assert.equal(app.retries, 0);
  app.show({ sessionId: "original", text: "草稿" });
  assert.equal(app.text, "增强结果");
});

function round(state, { sessionId = "original", seq = 1, turnId = "turn-1", reply = "第二项是为搜索结果添加缓存。",
  providerId = model.providerId, endedAt = state === "running" ? undefined : Date.now() } = {}) {
  const rows = [
    { kind: "turnHeader", rowId: 1, turnId, sourceCommandId: "command-1", origin: "userInput", executionKind: "agent", state, endedAt },
    { kind: "userInput", rowId: 2, turnId, sourceCommandId: "command-1", origin: "realUser", text: "请给出两个优化选项", modelSelection: { providerId } },
    { kind: "assistantText", rowId: 3, turnId, text: reply, state: state === "running" ? "streaming" : "complete", actions: { canFork: true } },
  ];
  return { sessionId, logEpoch: "log-1", seq, rows: { firstRowId: 1, lastRowId: 3, window: rows } };
}

test("冷打开已完成会话不会预热，空框三击保留原生输入", () => {
  const app = createFixture();
  app.show({ sessionId: "original", text: "", snapshot: round("completedSuccess") });
  app.threeSpaces();
  assert.equal(app.requests.length, 0);
  assert.equal(app.text, "   ");
});

test("只预生成一次，就绪后显示灰字，空框三击采纳为一步原生编辑", async () => {
  const app = createFixture();
  app.show({ sessionId: "original", text: "", snapshot: round("running") });
  app.show({ sessionId: "original", text: "", snapshot: round("completedSuccess", { seq: 2 }) });
  app.show({ sessionId: "original", text: "", snapshot: round("completedSuccess", { seq: 3 }) });
  assert.equal(app.requests.length, 1);
  assert.deepEqual(app.requests[0].payload, {
    ...model, mode: "prediction", previousUser: "请给出两个优化选项", previousReply: "第二项是为搜索结果添加缓存。",
  });
  assert.equal(app.preview, "");
  await app.finish(0, "请比较两个优化选项的风险。");
  assert.equal(app.preview, "请比较两个优化选项的风险。");
  assert.equal(app.text, "");
  app.edit("用户开始输入");
  assert.equal(app.preview, "");
  app.edit("");
  assert.equal(app.preview, "请比较两个优化选项的风险。");
  app.threeSpaces();
  assert.equal(app.text, "请比较两个优化选项的风险。");
  assert.equal(app.preview, "");
  assert.equal(app.requests.length, 1);
  assert.deepEqual(app.writes, [
    { text: "", tag: "history-merge" },
    { text: "请比较两个优化选项的风险。", tag: "history-push" },
  ]);
});

test("候选未就绪时三次空格原样输入，迟到结果不自动写入", async () => {
  const app = createFixture();
  app.show({ sessionId: "original", text: "", snapshot: round("running") });
  app.show({ sessionId: "original", text: "", snapshot: round("completedSuccess", { seq: 2 }) });
  app.threeSpaces();
  assert.equal(app.text, "   ");
  await app.finish(0, "可编辑的后续问题");
  assert.equal(app.text, "   ");
  assert.equal(app.writes.length, 0);
  assert.equal(app.requests.length, 1);
});

test("切换会话取消预测，慢返回和重新打开旧会话都不会提供候选", async () => {
  const app = createFixture();
  app.show({ sessionId: "original", text: "", snapshot: round("running") });
  const completed = round("completedSuccess", { seq: 2 });
  app.show({ sessionId: "original", text: "", snapshot: completed });
  app.show({ sessionId: "other", text: "", snapshot: round("completedSuccess", { sessionId: "other" }) });
  assert.equal(app.requests[0].signal.aborted, true);
  await app.finish(0, "迟到预测");
  assert.equal(app.preview, "");
  app.threeSpaces();
  assert.equal(app.text, "   ");
  app.show({ sessionId: "original", text: "", snapshot: completed });
  app.threeSpaces();
  assert.equal(app.text, "   ");
  assert.equal(app.requests.length, 1);
});

test("同一宿主轮次重新打开后完成，不会再次发出预测", async () => {
  const app = createFixture();
  app.show({ sessionId: "original", text: "", snapshot: round("running") });
  app.show({ sessionId: "original", text: "", snapshot: round("completedSuccess", { seq: 2 }) });
  await app.finish(0, "最初的候选");
  app.show({ sessionId: "original", text: "", snapshot: round("running", { seq: 3 }) });
  app.show({ sessionId: "original", text: "", snapshot: round("completedSuccess", { seq: 4 }) });
  app.threeSpaces();
  assert.equal(app.requests.length, 1);
  assert.equal(app.text, "   ");
});

test("有草稿、后台窗口、中断或换供应商都不预生成", () => {
  for (const { text = "", state = "completedSuccess", ...overrides } of [
    { text: "用户正在键入" }, { foreground: false }, { state: "completedInterrupted" },
    { createSubmissionFromComposer: () => ({ modelSelection: { ...model, providerId: "other-provider" } }) },
    { attachment: "data-composer-context-attachments-row" },
  ]) {
    const app = createFixture();
    app.show({ sessionId: "original", text, snapshot: round("running") });
    app.show({ sessionId: "original", text, snapshot: round(state, { seq: 2 }), ...overrides });
    assert.equal(app.requests.length, 0);
  }
});

for (const event of ["blur", "visibilitychange"]) {
  test(`收到 ${event} 后，恢复首帧只为后台结束的回复建立基线`, () => {
    const app = createFixture();
    app.show({ sessionId: "original", text: "", snapshot: round("running") });
    app.suspendWindow(event);
    const completed = round("completedSuccess", { seq: 2 });
    app.show({ sessionId: "original", text: "", snapshot: completed, foreground: false, paintComposer: false });
    app.show({ sessionId: "original", text: "", snapshot: completed });
    assert.equal(app.requests.length, 0);

    app.show({ sessionId: "original", text: "", snapshot: round("running", { turnId: "turn-2", seq: 3 }) });
    app.show({ sessionId: "original", text: "", snapshot: round("completedSuccess", { turnId: "turn-2", seq: 4 }) });
    assert.equal(app.requests.length, 1, "恢复后新产生的前台回复仍可预测");
  });

  test(`收到 ${event} 后，恢复首帧区分前台完成、后台完成和不同会话`, (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1000 });
    for (const { completedInForeground, originalSession, expected } of [
      { completedInForeground: true, originalSession: true, expected: 1 },
      { completedInForeground: false, originalSession: true, expected: 0 },
      { completedInForeground: true, originalSession: false, expected: 0 },
    ]) {
      const app = createFixture();
      app.show({ sessionId: "original", text: "", snapshot: round("running") });
      app.suspendWindow(event);
      t.mock.timers.tick(10);
      const backgroundTime = Date.now();
      t.mock.timers.tick(10);
      app.resumeWindow(event);
      t.mock.timers.tick(10);
      const endedAt = completedInForeground ? Date.now() : backgroundTime;
      const sessionId = originalSession ? "original" : "other";
      const snapshot = { ...round("completedSuccess", { seq: 2, endedAt }), sessionId };
      t.mock.timers.tick(10);
      app.show({ sessionId, text: "", snapshot });
      assert.equal(app.requests.length, expected);
    }
  });
}

test("恢复后补送旧运行及完成帧时，按宿主完成时间跳过预测", () => {
  const app = createFixture();
  const running = round("running");
  app.show({ sessionId: "original", text: "", snapshot: running });
  app.suspendWindow("blur");
  app.show({ sessionId: "original", text: "", snapshot: running });
  app.show({ sessionId: "original", text: "", snapshot: round("completedSuccess", { seq: 2, endedAt: Date.now() - 5000 }) });
  assert.equal(app.requests.length, 0);
});

test("终态缺少宿主完成时间时等待同轮的完整投影", () => {
  const app = createFixture();
  app.show({ sessionId: "original", text: "", snapshot: round("running") });
  app.show({ sessionId: "original", text: "", snapshot: round("completedSuccess", { seq: 2, endedAt: null }) });
  assert.equal(app.requests.length, 0);
  app.show({ sessionId: "original", text: "", snapshot: round("completedSuccess", { seq: 3 }) });
  assert.equal(app.requests.length, 1);
});

test("回复先完成，等输入框解锁后预测一次并显示灰字", async () => {
  const app = createFixture();
  const completed = round("completedSuccess", { seq: 2 });
  app.show({ sessionId: "original", text: "", snapshot: round("running") });
  app.show({ sessionId: "original", text: "", snapshot: completed, blockingRequestId: "sending" });
  assert.equal(app.requests.length, 0);
  app.show({ sessionId: "original", text: "", snapshot: completed });
  assert.equal(app.requests.length, 1);
  await app.finish(0, "请展开第二项的方案。");
  assert.equal(app.preview, "请展开第二项的方案。");
  app.threeSpaces();
  assert.equal(app.text, "请展开第二项的方案。");
});

test("同会话暂缺一帧宿主投影，随后真实完成仍可预测", () => {
  const app = createFixture();
  app.show({ sessionId: "original", text: "", snapshot: round("running") });
  app.show({ sessionId: "original", text: "", snapshot: null });
  app.show({ sessionId: "original", text: "", snapshot: round("completedSuccess", { seq: 2 }) });
  assert.equal(app.requests.length, 1);
});

test("已完成但暂缺选中模型，恢复时只接受原供应商", () => {
  for (const providerId of [model.providerId, "another-provider"]) {
    const app = createFixture();
    const completed = round("completedSuccess", { seq: 2 });
    app.show({ sessionId: "original", text: "", snapshot: round("running") });
    app.show({ sessionId: "original", text: "", snapshot: completed, createSubmissionFromComposer: () => null });
    assert.equal(app.requests.length, 0);
    app.show({ sessionId: "original", text: "", snapshot: completed,
      createSubmissionFromComposer: () => ({ modelSelection: { ...model, providerId } }) });
    assert.equal(app.requests.length, providerId === model.providerId ? 1 : 0);
  }
});

test("前台已就绪且归属一致的候选可在窗口恢复后采纳", async () => {
  const app = createFixture();
  app.show({ sessionId: "original", text: "", snapshot: round("running") });
  const completed = round("completedSuccess", { seq: 2 });
  app.show({ sessionId: "original", text: "", snapshot: completed });
  await app.finish(0, "请说明验收标准。");
  app.suspendWindow("visibilitychange");
  app.show({ sessionId: "original", text: "", snapshot: completed });
  app.threeSpaces();
  assert.equal(app.text, "请说明验收标准。");
  assert.equal(app.requests.length, 1);
});

test("有文字时三击增强，上一轮只随同供应商的增强请求发送", () => {
  for (const providerId of [model.providerId, "other-provider"]) {
    const app = createFixture();
    app.show({ sessionId: "original", text: "按第二项，只给方案", snapshot: round("completedSuccess", { providerId }) });
    app.threeSpaces();
    assert.equal(app.requests[0].payload.text, "按第二项，只给方案");
    assert.equal(app.requests[0].payload.mode, undefined);
    assert.equal(app.requests[0].payload.previousReply, providerId === model.providerId ? "第二项是为搜索结果添加缓存。" : undefined);
  }
});

test("模型原样返回时保留等待期间的新增文字", async () => {
  const app = createFixture();
  app.show({ sessionId: "original", text: "已有草稿 " });
  app.threeSpaces();
  app.type("继续补充");
  await app.finish(0, "已有草稿");
  assert.equal(app.text, "已有草稿 继续补充");
  assert.equal(app.writes.length, 1);
  assert.equal(app.status, "增强完成，草稿未改动");
  app.expireStatus();
  assert.equal(app.status, "");
});

test("待回填容量用尽时，拒绝新请求并保住所有已成功改写", async () => {
  const app = createFixture();
  for (let index = 0; index < 64; index++) {
    app.show({ sessionId: `origin-${index}`, text: `原稿 ${index}` });
    app.threeSpaces();
    app.show({ sessionId: "waiting", text: "" });
    await app.finish(index, `改写 ${index}`);
  }
  app.show({ sessionId: "overflow", text: "额外草稿" });
  app.threeSpaces();
  assert.equal(app.requests.length, 64);
  assert.equal(app.text, "额外草稿   ");
  assert.match(app.notices.at(-1), /队列已满/u);

  for (let index = 0; index < 64; index++) {
    app.show({ sessionId: `origin-${index}`, text: `原稿 ${index}` });
    assert.equal(app.text, `改写 ${index}`);
  }
  app.show({ sessionId: "overflow", text: "额外草稿" });
  app.threeSpaces();
  assert.equal(app.requests.length, 65);
});

test("在途改写占用容量，失败后允许新的请求", async () => {
  const app = createFixture();
  for (let index = 0; index < 64; index++) {
    app.show({ sessionId: `active-${index}`, text: `原稿 ${index}` });
    app.threeSpaces();
  }
  app.show({ sessionId: "overflow", text: "额外草稿" });
  app.threeSpaces();
  assert.equal(app.requests.length, 64);
  app.requests[0].resolve({ ok: false, kind: "timeout" });
  await Promise.resolve();
  app.threeSpaces();
  assert.equal(app.requests.length, 65);
});
