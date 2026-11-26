"use strict";

const assert = require("node:assert/strict");
const { setImmediate } = require("node:timers/promises");
const test = require("node:test");
const { installRate } = require("../src/rate.cjs");

const timeOrigin = 1_760_000_000_000;

function fixture(rowsRange) {
  let snapshot;
  let storeSnapshot;
  let invalidate;
  let frame;
  let shown;
  let directoryRevision = 0;
  const timers = new Map();
  let nextTimer = 0;
  let now = 0;
  let telemetry;
  let mounted = true;
  const anchor = {
    get previousElementSibling() { return shown; },
    before(node) { shown = node; },
  };
  const root = { return: null, stateNode: {} };
  root.stateNode.current = root;
  const provider = { return: root, memoizedProps: {} };
  const services = { zcodeAgentService: {
    onDynamicConversationTelemetryFact: () => (listener) => {
      telemetry = listener;
      return { dispose() { telemetry = undefined; } };
    },
  } };
  const store = { getState: () => ({ snapshot: storeSnapshot, turnNavigatorDirectoryRevision: directoryRevision }), transport: { rowsRange } };
  const pane = {
    __reactFiber$fixture: { return: provider },
    getAttribute: (name) => name === "data-session-id" ? snapshot.sessionId : String(snapshot.seq),
  };
  const composer = { closest: () => pane, __reactFiber$fixture: { return: root } };
  const surface = {
    closest: (selector) => selector.includes("v4-composer") ? composer : pane,
    querySelector: () => anchor,
  };
  const document = {
    querySelectorAll: () => mounted ? [surface] : [], documentElement: {},
    createElement() {
      const attributes = new Map();
      return {
        style: {}, dataset: {},
        setAttribute: (name, value) => attributes.set(name, value),
        getAttribute: (name) => attributes.get(name),
        remove() { if (shown === this) shown = undefined; },
      };
    },
  };
  const dispose = installRate({ document, window: {
    performance: { timeOrigin, now: () => now },
    MutationObserver: class {
      constructor(callback) { invalidate = callback; }
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame(callback) { frame = callback; return 1; },
    cancelAnimationFrame() { frame = null; },
    setTimeout(callback, delay) { timers.set(++nextTimer, { callback, at: now + delay }); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
  } });
  function paint() {
    const run = frame;
    frame = null;
    run?.();
  }
  return {
    show(sessionId, rows, firstRowId = 1, logEpoch = "epoch-1", historyRevision = directoryRevision) {
      directoryRevision = historyRevision;
      snapshot = { sessionId, seq: (snapshot?.seq || 0) + 1, logEpoch, rows: { firstRowId, window: rows } };
      storeSnapshot = snapshot;
      provider.memoizedProps = { sessionId, projectionStore: store, services, workspacePath: "workspace" };
      composer.__reactFiber$fixture.memoizedProps = { sessionId, snapshot, composerDraftScopeToken: Symbol() };
      invalidate();
      paint();
    },
    advanceEquivalentStore() {
      storeSnapshot = { ...snapshot, seq: snapshot.seq + 1, rows: { ...snapshot.rows, window: snapshot.rows.window.map(row => ({ ...row })) } };
      invalidate();
      paint();
    },
    receive(fact) {
      const defaults = fact.kind ? {} : { kind: "model.request.metrics", querySource: "main_turn" };
      telemetry?.({ sessionId: snapshot.sessionId, ...defaults, ...fact });
      paint();
    },
    mount(isMounted) {
      mounted = isMounted;
      invalidate();
      paint();
    },
    async settle() { await setImmediate(); paint(); },
    advance(ms) {
      now += ms;
      for (const [id, timer] of timers) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.callback();
      }
      paint();
    },
    get visible() { return shown; },
    dispose,
  };
}

const incomplete = { kind: "turnHeader", turnId: "latest", rowId: 12, state: "completedInterrupted" };
const rated = { kind: "turnHeader", turnId: "old", rowId: 1, state: "completedSuccess", outputTokens: 120, activeMs: 6000 };

test("工具等待和输出暂停期间保留本轮速率，下一轮不继承", (t) => {
  const pane = fixture(async () => assert.fail("不应读取历史"));
  t.after(pane.dispose);
  const header = { kind: "turnHeader", turnId: "a1", rowId: 1, state: "running" };
  const output = { kind: "assistantText", turnId: "a1", rowId: 2, text: "内容" };
  const tool = { kind: "toolCall", turnId: "a1", rowId: 3, status: "pendingApproval", inputText: "{}" };
  const finishedTool = { ...tool, status: "success" };
  pane.show("a", [header, output]);
  pane.advance(1000);
  pane.show("a", [header, { ...output, text: "文".repeat(202) }]);
  assert.equal(pane.visible?.textContent, "100.0 tok/s");
  pane.show("a", [header, { ...output, text: "文".repeat(202) }, tool]);
  assert.equal(pane.visible?.textContent, "100.0 tok/s", "等待工具时保持最后测得的速率");
  assert.equal(pane.visible?.title, "本轮最后一次实时估算");
  pane.advance(3000);
  pane.show("a", [header, { ...output, text: "文".repeat(202) }, finishedTool]);
  assert.equal(pane.visible?.textContent, "100.0 tok/s", "恢复生成前保持最后测得的速率");
  pane.advance(3000);
  const resumed = { kind: "assistantText", turnId: "a1", rowId: 4, text: "继续" };
  pane.show("a", [header, { ...output, text: "文".repeat(202) }, finishedTool, resumed]);
  pane.advance(1000);
  pane.show("a", [header, { ...output, text: "文".repeat(202) }, finishedTool, { ...resumed, text: "文".repeat(162) }]);
  assert.equal(pane.visible?.textContent, "80.0 tok/s");
  assert.equal(pane.visible?.title, "生成中实时估算");
  pane.advance(3000);
  assert.equal(pane.visible?.textContent, "80.0 tok/s", "无增量时保持最后测得的速率");
  assert.equal(pane.visible?.title, "本轮最后一次实时估算");
  pane.show("a", [{ ...header, state: "completedSuccess" }, { ...output, text: "文".repeat(202) },
    finishedTool, { ...resumed, text: "文".repeat(162) }]);
  assert.equal(pane.visible?.textContent, "90.0 tok/s", "均速只累计两段生成间隔");
  assert.equal(pane.visible?.title, "本轮生成均速（估算）");
  pane.show("a", [{ ...header, rowId: 6, turnId: "a2" }]);
  assert.equal(pane.visible, undefined);
});

test("完成态按本轮生成采样加权，不让首包和尾包等待把 100 tok/s 拉到 47", (t) => {
  const pane = fixture(async () => assert.fail("不应读取历史"));
  t.after(pane.dispose);
  const header = { kind: "turnHeader", turnId: "a1", sourceCommandId: "send-1", rowId: 1, state: "running" };
  const output = { kind: "assistantText", turnId: "a1", rowId: 2 };
  pane.show("a", [header]);
  pane.advance(2500);
  for (let count = 0; count <= 10; count++) {
    pane.show("a", [header, { ...output, text: "文".repeat(2 + count * 40) }]);
    pane.advance(200);
  }
  assert.equal(pane.visible?.textContent, "100.0 tok/s");
  pane.advance(5200);
  pane.receive({ sourceCommandId: "send-1", requestId: "r1", outputTokens: 470, durationMs: 10000, timeToFirstContentMs: 2500 });
  pane.show("a", [{ ...header, state: "completedSuccess", outputTokens: 470, activeMs: 10000 },
    { ...output, text: "文".repeat(402) }]);
  assert.equal(pane.visible?.textContent, "100.0 tok/s");
  assert.equal(pane.visible?.title, "本轮生成均速（估算）");
});

const runningRateTurn = {
  kind: "turnHeader", turnId: "a1", sourceCommandId: "send-1", rowId: 1, state: "running", startedAt: timeOrigin,
};
function streamedText(characters, rowId = 2) {
  return { kind: "assistantText", turnId: "a1", rowId, text: "文".repeat(characters) };
}
function endRateTurn(elapsed, tokens) {
  return {
    ...runningRateTurn, state: "completedSuccess", endedAt: timeOrigin + elapsed, activeMs: elapsed, outputTokens: tokens,
  };
}
function timedRateRequest(elapsed, tokens) {
  return {
    sourceCommandId: "send-1", requestId: "r1", durationMs: elapsed, timeToFirstContentMs: 0,
    outputTokens: tokens, occurredAt: timeOrigin + elapsed,
  };
}

const engineTurn = { sourceCommandId: "send-1", turnId: "engine-1" };
function requestStatus(pane, requestId, status, elapsed, eventSeq) {
  pane.receive({
    ...engineTurn, kind: "model.request.status", querySource: "main_turn",
    requestId, status, occurredAt: timeOrigin + elapsed, eventSeq,
  });
}
function requestChunk(pane, elapsed, eventSeq, firstChunk) {
  // 真实流式事件无 requestId，通过同轮当前主请求关联。
  pane.receive({
    ...engineTurn, kind: "stream.chunk", channel: "text", chunkLength: 10, firstChunk,
    occurredAt: timeOrigin + elapsed, eventSeq,
  });
}
function finishRequest(pane, requestId, { started, first, ended, tokens, eventSeq, reasoningTokens }) {
  requestStatus(pane, requestId, "model_request_completed", ended, eventSeq);
  const metrics = {
    ...engineTurn, requestId, querySource: "main_turn", outputTokens: tokens,
    reasoningTokens,
    durationMs: ended - started, timeToFirstContentMs: first - started,
    occurredAt: timeOrigin + ended, eventSeq,
  };
  pane.receive(metrics);
  return metrics;
}

for (const { outputMs, waitMs } of [{ outputMs: 1000, waitMs: 1128 }, { outputMs: 200, waitMs: 3300 }]) {
  test(`输出 ${outputMs} 毫秒后等待尾包 ${waitMs} 毫秒，均速保留 100 且标注估算`, (t) => {
    const pane = fixture(async () => assert.fail("不应读取历史"));
    t.after(pane.dispose);
    const tokens = outputMs / 10;
    const output = streamedText(2 + tokens * 2);
    pane.show("a", [runningRateTurn, streamedText(2)]);
    pane.advance(outputMs);
    pane.show("a", [runningRateTurn, output]);
    assert.equal(pane.visible?.textContent, "100.0 tok/s");

    const elapsed = outputMs + waitMs;
    pane.advance(waitMs);
    pane.receive(timedRateRequest(elapsed, tokens));
    pane.show("a", [endRateTurn(elapsed, tokens), output]);
    assert.equal(pane.visible?.textContent, "100.0 tok/s");
    assert.match(pane.visible?.title, /估算/u);
  });

  test(`宿主首末内容计时排除 ${waitMs} 毫秒尾包等待`, (t) => {
    const pane = fixture(async () => assert.fail("不应读取历史"));
    t.after(pane.dispose);
    const tokens = outputMs / 10;
    const output = streamedText(2 + tokens * 2);
    pane.show("a", [runningRateTurn, streamedText(2)]);
    requestStatus(pane, "r1", "model_request_started", 0, 1);
    requestChunk(pane, 0, 2, true);
    pane.advance(outputMs);
    pane.show("a", [runningRateTurn, output]);
    requestChunk(pane, outputMs, 3, false);
    assert.equal(pane.visible?.textContent, "100.0 tok/s");

    const elapsed = outputMs + waitMs;
    pane.advance(waitMs);
    pane.show("a", [endRateTurn(elapsed, tokens), output]);
    finishRequest(pane, "r1", { started: 0, first: 0, ended: elapsed, tokens, eventSeq: 4 });
    assert.equal(pane.visible?.textContent, "100.0 tok/s");
    assert.equal(pane.visible?.title, "本轮实际均速");
  });
}

test("完成投影晚于宿主 5 秒时，保留没有尾部等待的宿主计时", (t) => {
  const pane = fixture(async () => assert.fail("不应读取历史"));
  t.after(pane.dispose);
  const output = streamedText(202);
  pane.show("a", [runningRateTurn, streamedText(2)]);
  requestStatus(pane, "r1", "model_request_started", 0, 1);
  requestChunk(pane, 0, 2, true);
  pane.advance(1000);
  pane.show("a", [runningRateTurn, output]);
  requestChunk(pane, 1000, 3, false);
  assert.equal(pane.visible?.textContent, "100.0 tok/s");

  pane.advance(5000);
  finishRequest(pane, "r1", { started: 0, first: 0, ended: 1000, tokens: 120, eventSeq: 4 });
  pane.show("a", [endRateTurn(1000, 120), output]);
  assert.equal(pane.visible?.textContent, "120.0 tok/s");
  assert.equal(pane.visible?.title, "本轮实际均速");
});

test("切走再回到同一轮，均速累计切换前后的生成段", (t) => {
  const pane = fixture(async () => assert.fail("不应读取历史"));
  t.after(pane.dispose);
  pane.show("a", [runningRateTurn, streamedText(2)]);
  pane.advance(1000);
  pane.show("a", [runningRateTurn, streamedText(202)]);
  assert.equal(pane.visible?.textContent, "100.0 tok/s");

  pane.show("b", []);
  pane.advance(2000);
  pane.show("a", [runningRateTurn, streamedText(202)]);
  pane.advance(1000);
  pane.show("a", [runningRateTurn, streamedText(602)]);
  assert.equal(pane.visible?.textContent, "200.0 tok/s");
  pane.show("a", [endRateTurn(4000), streamedText(602)]);
  assert.equal(pane.visible?.textContent, "150.0 tok/s");
  assert.equal(pane.visible?.title, "本轮生成均速（估算）");
});

test("工具在两次投影间完成，均速仍排除工具执行间隔", (t) => {
  const pane = fixture(async () => assert.fail("不应读取历史"));
  t.after(pane.dispose);
  const first = streamedText(142);
  pane.show("a", [runningRateTurn, streamedText(2)]);
  pane.advance(700);
  pane.show("a", [runningRateTurn, first]);
  assert.equal(pane.visible?.textContent, "100.0 tok/s");

  const tool = {
    kind: "toolCall", turnId: "a1", rowId: 3, status: "success", inputText: "{}",
    startedAt: timeOrigin + 800, endedAt: timeOrigin + 2100,
  };
  pane.advance(1600);
  pane.show("a", [runningRateTurn, first, tool, streamedText(2, 4)]);
  pane.advance(400);
  const resumed = streamedText(82, 4);
  pane.show("a", [runningRateTurn, first, tool, resumed]);
  pane.show("a", [endRateTurn(2700), first, tool, resumed]);
  assert.equal(pane.visible?.textContent, "100.0 tok/s");
  assert.equal(pane.visible?.title, "本轮生成均速（估算）");
});

test("最后一批输出与回合完成同帧提交时，均速计入该批增量", (t) => {
  const pane = fixture(async () => assert.fail("不应读取历史"));
  t.after(pane.dispose);
  pane.show("a", [runningRateTurn, streamedText(2)]);
  pane.advance(1000);
  pane.show("a", [runningRateTurn, streamedText(202)]);
  assert.equal(pane.visible?.textContent, "100.0 tok/s");

  pane.advance(1000);
  pane.show("a", [endRateTurn(2000), streamedText(2002)]);
  assert.equal(pane.visible?.textContent, "500.0 tok/s");
  assert.equal(pane.visible?.title, "本轮生成均速（估算）");
});

test("本轮完整的逐请求计时扣除首包等待，并按实际生成时间加权", (t) => {
  const pane = fixture(async () => assert.fail("不应读取历史"));
  t.after(pane.dispose);
  pane.show("a", [endRateTurn(10000, 275)]);
  requestStatus(pane, "r1", "model_request_started", 0, 1);
  requestChunk(pane, 3000, 2, true);
  requestChunk(pane, 5000, 3, false);
  const first = finishRequest(pane, "r1", { started: 0, first: 3000, ended: 5500, tokens: 200, eventSeq: 4 });
  pane.receive(first); // 重发指标不重复累计。
  pane.receive({ ...first, sessionId: "b", requestId: "wrong-session" });
  pane.receive({ ...first, sourceCommandId: "send-0", requestId: "wrong-turn" });
  pane.receive({ ...first, querySource: "subagent", requestId: "wrong-source" });
  pane.receive({ ...first, kind: "model.request.status", requestId: "wrong-event" });
  assert.equal(pane.visible?.textContent, "100.0 tok/s");
  assert.equal(pane.visible?.title, "本轮已计时请求均速");
  requestStatus(pane, "r2", "model_request_started", 5500, 5);
  requestChunk(pane, 8000, 6, true);
  requestChunk(pane, 8500, 7, false);
  finishRequest(pane, "r2", { started: 5500, first: 8000, ended: 9000, tokens: 75, eventSeq: 8 });
  assert.equal(pane.visible?.textContent, "110.0 tok/s");
  assert.equal(pane.visible?.title, "本轮实际均速");
});

test("缺少请求的首个内容块时，单有用量和请求耗时无法标为实测", (t) => {
  const pane = fixture(async () => assert.fail("不应读取历史"));
  t.after(pane.dispose);
  pane.show("a", [runningRateTurn]);
  requestStatus(pane, "r1", "model_request_started", 0, 1);
  requestChunk(pane, 600, 3, false);
  requestChunk(pane, 800, 4, true); // 后续内容片段也会有首块，不能修补缺失的第一个内容块。
  requestChunk(pane, 1000, 5, false);
  finishRequest(pane, "r1", { started: 0, first: 400, ended: 2000, tokens: 100, eventSeq: 6 });
  pane.show("a", [endRateTurn(2000, 100)]);
  assert.equal(pane.visible?.textContent, "50.0 tok/s");
  assert.equal(pane.visible?.title, "本轮均速（含等待）");
});

test("隐式推理用量不能除以只覆盖正文的计时区间", (t) => {
  const pane = fixture(async () => assert.fail("不应读取历史"));
  t.after(pane.dispose);
  pane.show("a", [runningRateTurn, streamedText(2)]);
  requestStatus(pane, "r1", "model_request_started", 0, 1);
  requestChunk(pane, 0, 2, true);
  pane.advance(1000);
  const output = streamedText(202);
  pane.show("a", [runningRateTurn, output]);
  requestChunk(pane, 1000, 3, false);
  finishRequest(pane, "r1", { started: 0, first: 0, ended: 2000, tokens: 1000, reasoningTokens: 900, eventSeq: 4 });
  pane.advance(1000);
  pane.show("a", [endRateTurn(2000, 1000), output]);
  assert.equal(pane.visible?.textContent, "100.0 tok/s");
  assert.equal(pane.visible?.title, "本轮生成均速（估算）");

  const next = { ...runningRateTurn, turnId: "a2", sourceCommandId: "send-2", rowId: 3 };
  const nextText = { ...streamedText(2, 4), turnId: "a2" };
  pane.show("a", [next, nextText]);
  pane.advance(1000);
  pane.show("a", [next, { ...nextText, text: "文".repeat(202) }]);
  assert.equal(pane.visible?.textContent, "100.0 tok/s", "隐式推理的用量也不能污染下一轮的换算");
});

test("同一请求内的长时间输出中断会回退到连续生成段的估算", (t) => {
  const pane = fixture(async () => assert.fail("不应读取历史"));
  t.after(pane.dispose);
  pane.show("a", [runningRateTurn, streamedText(2)]);
  requestStatus(pane, "r1", "model_request_started", 0, 1);
  requestChunk(pane, 0, 2, true);
  pane.advance(1000);
  pane.show("a", [runningRateTurn, streamedText(202)]);
  requestChunk(pane, 1000, 3, false);
  pane.advance(9000);
  pane.show("a", [runningRateTurn, streamedText(204)]);
  requestChunk(pane, 10000, 4, false);
  pane.advance(1000);
  const final = streamedText(404);
  pane.show("a", [runningRateTurn, final]);
  requestChunk(pane, 11000, 5, false);
  finishRequest(pane, "r1", { started: 0, first: 0, ended: 11000, tokens: 200, eventSeq: 6 });
  pane.show("a", [endRateTurn(11000, 200), final]);
  assert.equal(pane.visible?.textContent, "100.0 tok/s");
  assert.equal(pane.visible?.title, "本轮生成均速（估算）");
});

test("重新打开长回合等待补拉轮头时保留同轮读数，切换日志则隐藏", (t) => {
  const pane = fixture(async () => assert.fail("不应读取历史"));
  t.after(pane.dispose);
  pane.show("a", [runningRateTurn, streamedText(2)]);
  pane.advance(1000);
  pane.show("a", [runningRateTurn, streamedText(202)]);
  pane.show("b", []);
  pane.show("a", [streamedText(202)], 1);
  assert.equal(pane.visible?.textContent, "100.0 tok/s");
  assert.equal(pane.visible?.title, "本轮最后一次实时估算");
  pane.show("a", [streamedText(202)], 1, "epoch-2");
  assert.equal(pane.visible, undefined);
});

test("请求中途取消并重新订阅时，缺失的尾部内容不能标为实测", (t) => {
  const pane = fixture(async () => assert.fail("不应读取历史"));
  t.after(pane.dispose);
  pane.show("a", [runningRateTurn]);
  requestStatus(pane, "r1", "model_request_started", 0, 1);
  requestChunk(pane, 300, 2, true);
  requestChunk(pane, 400, 3, false);
  pane.mount(false);
  requestChunk(pane, 1100, 4, false);
  pane.mount(true);
  finishRequest(pane, "r1", { started: 0, first: 300, ended: 2000, tokens: 100, eventSeq: 5 });
  pane.show("a", [endRateTurn(2000, 100)]);
  assert.equal(pane.visible?.textContent, "50.0 tok/s");
  assert.equal(pane.visible?.title, "本轮均速（含等待）");
});

for (const toolLifecycleOnly of [false, true]) {
  const toolSource = toolLifecycleOnly ? "宿主工具事件" : "工具投影";
  test(`${toolSource}标明存在工具调用时，不把纯文本首末区间标为整轮实测`, (t) => {
    const pane = fixture(async () => assert.fail("不应读取历史"));
    t.after(pane.dispose);
    pane.show("a", [runningRateTurn]);
    requestStatus(pane, "r1", "model_request_started", 0, 1);
    requestChunk(pane, 300, 2, true);
    requestChunk(pane, 800, 3, false);
    finishRequest(pane, "r1", { started: 0, first: 300, ended: 1000, tokens: 90, eventSeq: 4 });
    const tool = {
      kind: "toolCall", turnId: "a1", rowId: 3, status: "success", inputText: "{}",
      startedAt: timeOrigin + 1100, endedAt: timeOrigin + 1300,
    };
    if (toolLifecycleOnly) pane.receive({
      ...engineTurn, kind: "tool.lifecycle", status: "started", toolCallId: "tool-1",
      occurredAt: timeOrigin + 1100, eventSeq: 5,
    });
    const header = { ...endRateTurn(2000, 90), toolDurationMs: 200 };
    pane.show("a", toolLifecycleOnly ? [header] : [header, tool]);
    assert.equal(pane.visible?.textContent, "50.0 tok/s");
    assert.equal(pane.visible?.title, "本轮均速（含等待）");
  });
}

test("历史均速能跨过未加载窗口及分页边界，并扣除完整工具耗时", async (t) => {
  const calls = [];
  const pane = fixture(async ({ sessionId, beforeRowId }) => {
    calls.push({ sessionId, beforeRowId });
    const rows = beforeRowId === 12 ? [{
      kind: "toolCall", turnId: "old", rowId: 8, status: "completed", startedAt: 2000, endedAt: 4000,
    }] : [rated, {
      kind: "toolCall", turnId: "old", rowId: 5, status: "completed", startedAt: 1000, endedAt: 3000,
    }];
    return { atLogEpoch: "epoch-1", rows };
  });
  t.after(pane.dispose);
  pane.show("a", [incomplete]);
  await pane.settle();
  assert.deepEqual(calls, [{ sessionId: "a", beforeRowId: 12 }, { sessionId: "a", beforeRowId: 8 }]);
  assert.equal(pane.visible?.textContent, "40.0 tok/s");
  assert.equal(pane.visible?.title, "本会话最近均速（含等待）");
});

test("旧会话或旧日志的历史读取返回后不会写入当前会话", async (t) => {
  const previous = Promise.withResolvers();
  let calls = 0;
  const pane = fixture(() => { calls++; return previous.promise; });
  t.after(pane.dispose);
  pane.show("a", [incomplete]);
  await pane.settle();
  assert.equal(calls, 1);
  pane.show("b", [incomplete], 12, "epoch-2");
  previous.resolve({ atLogEpoch: "epoch-1", rows: [rated] });
  await pane.settle();
  assert.equal(pane.visible, undefined);
});

const unreadableTool = { kind: "unreadable", sourceKind: "toolCall", turnId: "old", rowId: 2 };

test("工具记录不可读取时按可用的权威耗时计算，本轮和两种历史走同一规则", async (t) => {
  const current = fixture(async () => assert.fail("不应读取历史"));
  const paged = fixture(async () => ({ atLogEpoch: "epoch-1", rows: [rated, unreadableTool] }));
  t.after(current.dispose);
  t.after(paged.dispose);

  current.show("a", [rated, unreadableTool]);
  assert.equal(current.visible, undefined);
  current.show("a", [{ ...rated, modelDurationMs: 3000 }, unreadableTool]);
  assert.equal(current.visible?.textContent, "40.0 tok/s");
  assert.equal(current.visible?.title, "本轮均速（含等待）");
  current.show("a", [rated, { ...unreadableTool, sourceKind: "subagent" }, incomplete]);
  assert.equal(current.visible, undefined);
  current.show("a", [{ ...rated, toolDurationMs: 2000 }, unreadableTool, incomplete]);
  assert.equal(current.visible?.textContent, "30.0 tok/s");
  assert.equal(current.visible?.title, "本会话最近均速（含等待）");
  paged.show("a", [incomplete]);
  await paged.settle();
  assert.equal(paged.visible, undefined);
});

test("等价投影共享在途查询和已显示历史，晚到本轮用量即时接管", async (t) => {
  const result = Promise.withResolvers();
  let calls = 0;
  const pane = fixture(() => { calls++; return result.promise; });
  t.after(pane.dispose);
  for (let index = 0; index < 5; index++) pane.show("a", [{ ...incomplete }]);
  assert.equal(calls, 1);
  result.resolve({ atLogEpoch: "epoch-1", rows: [rated] });
  await pane.settle();
  assert.equal(pane.visible?.textContent, "20.0 tok/s");
  pane.show("a", [{ ...incomplete }]);
  assert.equal(calls, 1);
  assert.equal(pane.visible?.textContent, "20.0 tok/s");

  pane.show("a", [{ ...incomplete, outputTokens: 80 }]);
  assert.equal(calls, 1);
  assert.equal(pane.visible?.textContent, "20.0 tok/s");

  pane.show("a", [{ ...incomplete, outputTokens: 80, modelDurationMs: 2000 }]);
  assert.equal(pane.visible?.textContent, "40.0 tok/s");
  assert.equal(pane.visible?.title, "本轮均速（含等待）");
});

test("宿主 store 比输入框提前提交等价快照时，历史结果和在途查询仍可复用", async (t) => {
  const pending = Promise.withResolvers();
  let calls = 0;
  const pane = fixture(() => { calls++; return pending.promise; });
  t.after(pane.dispose);
  pane.show("a", [incomplete]);
  pane.advanceEquivalentStore();
  pending.resolve({ atLogEpoch: "epoch-1", rows: [rated] });
  await pane.settle();
  assert.equal(pane.visible?.textContent, "20.0 tok/s");

  pane.show("a", [incomplete]);
  pane.advanceEquivalentStore();
  assert.equal(pane.visible?.textContent, "20.0 tok/s");
  assert.equal(calls, 1);
});

test("同一日志发生历史改写或新回合时重新查询，旧分页不能覆盖新结果", async (t) => {
  const requests = [];
  const pane = fixture((request) => {
    const result = Promise.withResolvers();
    requests.push({ ...request, ...result });
    return result.promise;
  });
  t.after(pane.dispose);
  pane.show("a", [incomplete]);
  pane.show("a", [incomplete], 1, "epoch-1", 1);
  assert.equal(requests.length, 2);
  requests[0].resolve({ atLogEpoch: "epoch-1", rows: [rated] });
  await pane.settle();
  assert.equal(pane.visible, undefined);
  requests[1].resolve({ atLogEpoch: "epoch-1", rows: [{ ...rated, outputTokens: 180 }] });
  await pane.settle();
  assert.equal(pane.visible?.textContent, "30.0 tok/s");

  pane.show("a", [{ ...incomplete, rowId: 22, turnId: "next" }]);
  assert.equal(requests.at(-1).beforeRowId, 22);
  assert.equal(requests.length, 3);
  assert.equal(pane.visible, undefined);
});

test("历史请求失败后限频重试，同一历史边界不逐帧重发", async (t) => {
  let calls = 0;
  const pane = fixture(async () => {
    if (++calls === 1) throw new Error("临时不可用");
    return { atLogEpoch: "epoch-1", rows: [rated] };
  });
  t.after(pane.dispose);
  pane.show("a", [incomplete]);
  await pane.settle();
  for (let index = 0; index < 5; index++) pane.show("a", [incomplete]);
  assert.equal(calls, 1);
  pane.advance(1000);
  await pane.settle();
  assert.equal(calls, 2);
  assert.equal(pane.visible?.textContent, "20.0 tok/s");
});

test("旧页水位不足时暂不显示，允许恢复后取同一日志的新页", async (t) => {
  let calls = 0;
  const pane = fixture(async () => ({ atLogEpoch: "epoch-1", atSeq: calls++ === 0 ? 0 : 2, rows: [rated] }));
  t.after(pane.dispose);
  pane.show("a", [incomplete]);
  await pane.settle();
  assert.equal(pane.visible, undefined);
  pane.show("a", [incomplete]);
  assert.equal(calls, 1);
  pane.advance(1000);
  await pane.settle();
  assert.equal(calls, 2);
  assert.equal(pane.visible?.textContent, "20.0 tok/s");
});

test("跨游标的旧工具行变化会重查历史并采用完整耗时", async (t) => {
  const calls = [];
  const pane = fixture(async ({ beforeRowId }) => {
    calls.push(beforeRowId);
    return { atLogEpoch: "epoch-1", rows: [rated] };
  });
  t.after(pane.dispose);
  const oldTool = { kind: "toolCall", turnId: "old", rowId: 13, status: "success", startedAt: 1000, endedAt: 3000 };
  pane.show("a", [incomplete, oldTool]);
  await pane.settle();
  assert.equal(pane.visible?.textContent, "30.0 tok/s");
  pane.show("a", [incomplete, { ...oldTool, endedAt: 4000 }]);
  await pane.settle();
  assert.deepEqual(calls, [12, 12]);
  assert.equal(pane.visible?.textContent, "40.0 tok/s");
});
