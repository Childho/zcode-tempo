"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { MAX_REPLY_CHARS, readLatestTurn, selectReplyExcerpt } = require("../src/reply-context.cjs");

const sessionId = "sess-test";
const canonicalTurn = "turn-current";

function header(rowId, state = "completedSuccess", fields = {}) {
  return {
    rowId, kind: "turnHeader", productTurnId: canonicalTurn, turnId: "runtime-header",
    origin: "userInput", executionKind: "agent", state, sourceCommandId: "current-command",
    visibility: "visible", ...fields,
  };
}

function input(rowId, fields = {}) {
  return {
    rowId, kind: "userInput", productTurnId: canonicalTurn, turnId: "runtime-input",
    origin: "realUser", inputOrigin: "desktop", sourceCommandId: "current-command",
    modelSelection: { providerId: "fixture-provider", modelId: "fixture-model" },
    text: "解释原因", visibility: "visible", ...fields,
  };
}

function assistant(rowId, text, fields = {}) {
  return {
    rowId, kind: "assistantText", productTurnId: canonicalTurn, turnId: "runtime-assistant",
    state: "complete", text, actions: { canFork: true }, visibility: "visible", ...fields,
  };
}

function snapshot(window, fields = {}) {
  return { sessionId, logEpoch: "epoch-1", rows: { window }, ...fields };
}

function read(rows, fields) {
  return readLatestTurn(snapshot(rows, fields), sessionId);
}

test("同一用户轮从运行到完成使用同一个 key，并只读取最终正文", () => {
  const oldRows = [
    header(1, "completedSuccess", { productTurnId: "older" }),
    input(2, { productTurnId: "older" }),
    assistant(3, "旧轮回复", { productTurnId: "older" }),
  ];
  const thinking = { rowId: 12, productTurnId: canonicalTurn, kind: "reasoning", text: "内部推理" };
  const intermediate = assistant(13, "中间说明", { actions: undefined });
  const final = assistant(14, "  最终回复\n第二段  ");
  const afterTool = { rowId: 15, productTurnId: canonicalTurn, kind: "toolCall", backgrounded: true };
  const running = read([...oldRows, header(10, "running"), input(11), thinking, intermediate]);
  const finishedHeader = header(10, "completedSuccess", { endedAt: 1700000000000 });
  const finished = read([...oldRows, finishedHeader, input(11), thinking, intermediate, final, afterTool]);
  assert.deepEqual(running, {
    key: JSON.stringify([sessionId, "epoch-1", canonicalTurn]), rowId: 10, state: "running", endedAt: undefined,
    reply: "", userText: "", providerId: "",
  });
  assert.deepEqual(finished, {
    ...running, state: "completedSuccess", endedAt: finishedHeader.endedAt, reply: final.text,
    userText: "解释原因", providerId: "fixture-provider",
  });
  assert.deepEqual(read([...oldRows, finishedHeader, input(11), final]), finished);
  assert.notEqual(read([header(10), input(11), final], { logEpoch: "epoch-2" }).key, running.key);
});

test("使用本轮原始用户输入，排除 guide、旧输入和 epilogue", () => {
  const rows = [
    header(4),
    input(5, { text: "旧输入", sourceCommandId: "previous-command", rootSourceCommandId: "current-command" }),
    input(6, {
      text: "主体🙂\n尾注样板", epilogueStart: "主体🙂".length,
    }),
    input(7, { text: "中途指导", guided: true }),
    input(8, { text: "代发内容", source: { kind: "extension", pluginId: "fixture" } }),
    input(9, { text: "后台结果", origin: "backgroundResult" }),
  ];
  const result = read(rows);
  assert.equal(result.userText, "主体🙂");
  assert.equal(result.providerId, "fixture-provider");
  assert.equal(result.reply, "");
  assert.equal(read([header(4), input(6, { epilogueStart: 0 })]).userText, "");
  assert.equal(read([header(4), input(6, { epilogueStart: 999 })]).userText, "");
  assert.equal(read([header(4), input(6, { modelSelection: undefined })]).providerId, "");
});

test("带附件或会话引用时停用预测所需的用户正文，保留可信答复和提供商", () => {
  for (const references of [
    { attachments: [{ name: "附件.txt" }] },
    { conversationQuotes: [{ text: "引用正文" }] },
  ]) {
    const result = read([header(4), input(5, { text: "正文及附件引用", ...references }), assistant(6, "完成回复")]);
    assert.equal(result.userText, "");
    assert.equal(result.reply, "完成回复");
    assert.equal(result.providerId, "fixture-provider");
  }
  assert.equal(read([header(4), input(5, { attachments: [], conversationQuotes: [] })]).userText, "解释原因");
});

test("桌面 UUIDv7 命令是直接输入，定时和手动运行的自动化都排除", () => {
  const readCommand = sourceCommandId => read([
    header(1, "completedSuccess", { sourceCommandId }), input(2, { sourceCommandId }), assistant(3, "结果"),
  ]);
  assert.equal(readCommand("01a21100-bac6-702a-ac9c-aa5ef6587da8").userText, "解释原因");
  assert.equal(readCommand("fixture-automation:1795581590680").reply, "");
  assert.equal(readCommand("fixture-automation:manual:9952a76b-a87e-4f8f-a298-9d876bdaaeea").reply, "");
  assert.equal(readCommand("fixture-legacy:0").userText, "解释原因");
});

test("会话不符、冷加载缺头和跨轮正文不形成上下文", () => {
  assert.equal(readLatestTurn(snapshot([header(1), input(2)]), "sess-other"), null);
  assert.equal(read([input(2), assistant(3, "尾窗缺少轮头")]), null);
  assert.equal(read([header(1), input(2)], { logEpoch: "" }), null);
  const crossTurn = assistant(3, "另一轮", { productTurnId: "other" });
  assert.equal(read([header(1), input(2), crossTurn]).reply, "");
  const actionButMissingInput = read([header(1), assistant(3, "可见但无用户输入")]);
  assert.equal(actionButMissingInput.reply, "");
  assert.equal(actionButMissingInput.userText, "");
});

test("忽略后台轮、合成输入和重复历史，保留编辑重跑的新边界", () => {
  const rows = [
    header(1), input(2), assistant(3, "上次答复"),
    header(4, "completedSuccess", { productTurnId: "background", origin: "backgroundResult" }),
    input(5, { productTurnId: "background", origin: "backgroundResult" }),
    assistant(6, "异步通知", { productTurnId: "background" }),
  ];
  assert.equal(read(rows).reply, "上次答复");
  const rerun = header(7, "failed", { origin: "editRerun" });
  const failed = read([...rows, rerun, input(8, { text: "重跑本次输入" }), assistant(9, "残片")]);
  assert.equal(failed.rowId, 7);
  assert.equal(failed.state, "failed");
  assert.equal(failed.reply, "");
  assert.equal(failed.userText, "");
  const rerunCompleted = { ...rerun, state: "completedSuccess" };
  assert.equal(read([...rows, rerunCompleted, input(8, { text: "重跑本次输入" })]).userText, "重跑本次输入");
  assert.equal(read([...rows, rerunCompleted, input(8, { origin: "synthetic" })]).userText, "");
  assert.equal(read([...rows, rerunCompleted, input(8), input(9)]).userText, "");
});

test("只使用有完成标记的最终回复，拒绝未完成、进度叙述和未授权来源", () => {
  assert.equal(read([header(1), input(2), assistant(3, "未标记", { actions: {} })]).reply, "");
  assert.equal(read([header(1, "completedInterrupted"), input(2), assistant(3, "中断")]).reply, "");
  assert.equal(read([header(1), input(2), assistant(3, "旧完成块"), assistant(4, "流式", { state: "streaming" })]).reply, "");
  assert.equal(read([header(1), input(2), assistant(3, "隐藏", { visibility: "hidden" })]).reply, "");
  assert.equal(read([header(1), input(2, { source: { kind: "session" } }), assistant(3, "代发")]).reply, "");
  assert.equal(read([header(1), input(2), assistant(3, "准备运行工具"), {
    rowId: 4, productTurnId: canonicalTurn, kind: "toolCall", status: "success",
  }]).reply, "");
  assert.equal(read([header(1), input(2), assistant(3, "已完成", { actions: { canRetry: true } }), {
    rowId: 4, productTurnId: canonicalTurn, kind: "toolCall", status: "success",
    display: { kind: "node_repl_images", source: "browser_turn_end" },
  }]).reply, "已完成");
});

const fill = "背景".repeat(MAX_REPLY_CHARS);

test("短回复保留全文，长回复需要明确指向", () => {
  const short = " 🙂 " + "字".repeat(MAX_REPLY_CHARS - 4);
  assert.equal(short.length, MAX_REPLY_CHARS);
  assert.equal(selectReplyExcerpt(short, "继续"), short);
  assert.equal(selectReplyExcerpt(fill, "再展开一点"), "");
  assert.equal(selectReplyExcerpt(fill + "\n\n## 独立章节\n" + fill, "展开「独立章节」"), "");
});

test("按唯一编号或明确标题摘录同一原段", () => {
  const reply = fill + "\n\n1. 起因\n文字甲\n\n2. 回滚\n文字乙\n\n3. 观测\n文字丙";
  assert.equal(selectReplyExcerpt(reply, "细化第 2 项"), "2. 回滚\n文字乙");
  assert.equal(selectReplyExcerpt(reply, "细化第二步"), "2. 回滚\n文字乙");
  assert.equal(selectReplyExcerpt(reply, "沿用「回滚」那一节"), "2. 回滚\n文字乙");
  assert.equal(selectReplyExcerpt(reply, "细化第2项，再写第3项"), "");
  const markdown = fill + "\r\n\r\n## 关键条件\r\n只在通过后切换\r\n\r\n## 验收\r\n保留原测试";
  assert.equal(selectReplyExcerpt(markdown, "把关键条件这一节 展开"), "## 关键条件\r\n只在通过后切换");
  assert.equal(selectReplyExcerpt(markdown + "\r\n\r\n## 关键条件\r\n另一段", "展开「关键条件」"), "");
});

test("按完整路径查找独立段落，避免前缀、URL 和重复正文", () => {
  const exact = "实现集中在 src/cache.ts，保留现有入口。";
  const reply = fill + "\n\n" + exact + "\n\n测试在 src/cache.test.ts。\n";
  assert.equal(selectReplyExcerpt(reply, "展开 (src/cache.ts) 的实现"), exact);
  assert.equal(selectReplyExcerpt(reply, "请看 https://example.invalid/src/cache.ts"), "");
  assert.equal(selectReplyExcerpt(reply + "\n另一个改动也涉及 src/cache.ts", "看 src/cache.ts"), "");
  const windows = "读 `C:\\Demo Data\\reports\\Q4.csv` 即可。";
  assert.equal(selectReplyExcerpt(reply + "\n" + windows, "解释 'C:\\Demo Data\\reports\\Q4.csv'"), windows);
});

test("不会把围栏中的编号当成段落标题，路径命中时保留整段代码", () => {
  const fence = "```txt\n2. 这是代码内容\nsrc/unique.ts\n\n这里仍在围栏内\n```";
  const reply = fill + "\n\n" + fence + "\n\n2. 真实项目\n执行描述";
  assert.equal(selectReplyExcerpt(reply, "说说第二项"), "2. 真实项目\n执行描述");
  assert.equal(selectReplyExcerpt(reply, "例子用 src/unique.ts 的写法"), fence);
});

test("列表里的长围栏保留原文，内部编号和短围栏不影响定位", () => {
  const item = "2. 真实项目\r\n执行描述";
  for (const [gap, indent] of [[" ", "    "], ["\t", "\t"]]) {
    const fence = ["````txt", "2. 这是代码内容", "```", "src/unique.ts", "", "````"]
      .map(line => line && indent + line).join("\r\n");
    const reply = `${fill}\r\n\r\n10.${gap}诊断样例\r\n\r\n${fence}\r\n\r\n${item}`;
    assert.equal(selectReplyExcerpt(reply, "说说第二项"), item);
    assert.equal(selectReplyExcerpt(reply, "例子用 src/unique.ts 的写法"), fence);
  }
});

test("缩进退回列表外时结束未关闭的围栏，后续编号仍可定位", () => {
  const fence = ["     ~~~txt", "     2. 这是代码内容", "     src/unique.ts"].join("\n");
  const item = "2. 真实项目\n执行描述";
  const reply = `${fill}\n\n1. 诊断样例\n   - 内层列表\n\n${fence}\n${item}`;
  assert.equal(selectReplyExcerpt(reply, "说说第二项"), item);
  assert.equal(selectReplyExcerpt(reply, "例子用 src/unique.ts 的写法"), fence);
});

test("超大正文或超过八个不同锚点时回退到无上下文", () => {
  const segment = "## 安装步骤\n在测试环境验证。";
  assert.equal(selectReplyExcerpt("大".repeat(65536) + "\n\n" + segment, "修改「安装步骤」"), "");
  assert.equal(selectReplyExcerpt(fill + "\n\n" + segment,
    "修改「安装步骤」并参考「甲」「乙」「丙」「丁」「戊」「己」「庚」「辛」"), "");
});
