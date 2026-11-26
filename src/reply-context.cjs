"use strict";

const { markdownLines } = require("./markdown-fences.cjs");

const MAX_REPLY_CHARS = 1200;
const MAX_EXCERPT_SOURCE_CHARS = 64 * 1024;
const MAX_EXCERPT_ANCHORS = 8;
const USER_TURN_ORIGINS = new Set(["userInput", "editRerun"]);
const TURN_STATES = new Set(["running", "completedSuccess", "completedInterrupted", "failed"]);

function turnIdentity(row) {
  return row.productTurnId || row.turnId;
}

function isVisible(row) {
  return row.visibility === "visible" || row.visibility === undefined;
}

function isAutomationRunId(commandId) {
  if (typeof commandId !== "string") return false;
  const separator = commandId.indexOf(":");
  if (separator <= 0) return false;
  // 与 ZCode 4.0 的 parseAutomationRunId 一致。桌面聊天命令使用不含冒号的 UUIDv7。
  const suffix = commandId.slice(separator + 1);
  if (suffix.startsWith("manual:")) return suffix.length > "manual:".length;
  const scheduledAt = Number(suffix);
  return Number.isSafeInteger(scheduledAt) && scheduledAt > 0;
}

function isDirectInput(row) {
  // ZCode 的 source 仅在插件、其他会话或交互视图代发时出现。
  return row.kind === "userInput" && row.origin === "realUser" && row.guided !== true
    && row.source == null && !row.botGroupSource && !isAutomationRunId(row.sourceCommandId);
}

function userBody(input) {
  if (typeof input?.text !== "string" || input.attachments?.length || input.conversationQuotes?.length) return "";
  const start = input.epilogueStart;
  if (start === undefined) return input.text;
  return Number.isSafeInteger(start) && start >= 0 && start <= input.text.length
    ? input.text.slice(0, start) : "";
}

function terminalReply(rows, input) {
  if (!input) return "";
  const finalIndex = rows.findLastIndex(row => row.kind === "assistantText");
  const final = rows[finalIndex];
  if (!final || final.rowId <= input.rowId || final.state !== "complete"
    || (final.actions?.canFork !== true && final.actions?.canRetry !== true)
    || typeof final.text !== "string" || !final.text.trim()) return "";

  // 截图是 ZCode 在回复之后添加的展示行。普通前台工具出现在最后正文之后时，无法证明该正文是答复。
  const hasFollowingTool = rows.slice(finalIndex + 1).some(row => !row.backgrounded && (
    row.kind === "subagent" || (row.kind === "toolCall"
      && !(row.display?.kind === "node_repl_images" && row.display.source === "browser_turn_end"))
  ));
  return hasFollowingTool ? "" : final.text;
}

function readLatestTurn(snapshot, sessionId) {
  if (typeof sessionId !== "string" || !sessionId || snapshot?.sessionId !== sessionId
    || typeof snapshot.logEpoch !== "string" || !snapshot.logEpoch || !Array.isArray(snapshot.rows?.window)) {
    return null;
  }

  const rows = snapshot.rows.window;
  const headerIndex = rows.findLastIndex(row => row?.kind === "turnHeader" && isVisible(row)
    && USER_TURN_ORIGINS.has(row.origin) && row.executionKind !== "controlOnly");
  const header = rows[headerIndex];
  if (!header || !Number.isSafeInteger(header.rowId) || !TURN_STATES.has(header.state)) return null;
  const identity = turnIdentity(header);
  if (typeof identity !== "string" || !identity) return null;
  const turn = {
    key: JSON.stringify([sessionId, snapshot.logEpoch, identity]),
    rowId: header.rowId,
    state: header.state,
    endedAt: header.endedAt,
    reply: "",
    userText: "",
    providerId: "",
  };
  if (header.state !== "completedSuccess") return turn;

  const tail = rows.slice(headerIndex + 1).filter(row => row && isVisible(row)
    && Number.isSafeInteger(row.rowId) && row.rowId > header.rowId);
  if (tail.some(row => isDirectInput(row) && turnIdentity(row) !== identity)) return null;
  const turnRows = tail.filter(row => turnIdentity(row) === identity);
  const inputs = turnRows.filter(row => isDirectInput(row)
    && (!header.sourceCommandId || row.sourceCommandId === header.sourceCommandId));
  const input = inputs.length === 1 ? inputs[0] : null;
  const provider = input?.modelSelection?.providerId;

  return {
    ...turn,
    reply: terminalReply(turnRows, input),
    userText: userBody(input),
    providerId: typeof provider === "string" ? provider : "",
  };
}

const NUMBER_TEXT = String.raw`[0-9]+(?:\.[0-9]+)*|[一二三四五六七八九十两]+`;
const DIGITS = "零一二三四五六七八九";
const ORDERED_LINE = new RegExp(`^([ \t]*)(?:[-*+]\\s+)?(${NUMBER_TEXT})[.)、）．][ \t]*(\\S.*)$`, "u");
const DRAFT_NUMBER = new RegExp(`(?:第\\s*(${NUMBER_TEXT})\\s*(?:项|条|点|节|段|步|章|部分)|(?:编号|方案|步骤|选项|小节|章节)[：:\\s]*(${NUMBER_TEXT})(?![.\\d一二三四五六七八九十两]))`, "gu");

function normalizeNumber(value) {
  if (/^\d+(?:\.\d+)*$/u.test(value)) return value;
  const digits = value.replaceAll("两", "二").split("十");
  if (digits.length === 1) return value.length === 1 ? String(DIGITS.indexOf(digits[0])) : "";
  if (digits.length !== 2 || digits.some(item => item.length > 1)) return "";
  const [tens, ones] = digits;
  return String((tens ? DIGITS.indexOf(tens) : 1) * 10 + (ones ? DIGITS.indexOf(ones) : 0));
}

function bareTitle(value) {
  const title = value.trim().replace(/[ \t]+#+[ \t]*$/u, "");
  const bold = /^\*\*(.+)\*\*$/u.exec(title);
  return (bold ? bold[1] : title).trim();
}

const QUOTED_SPAN = /`([^`\r\n]+)`|「([^」\r\n]+)」|『([^』\r\n]+)』|“([^”\r\n]+)”|‘([^’\r\n]+)’|"([^"\r\n]+)"|'([^'\r\n]+)'/gu;

function quotedSpans(text) {
  return Array.from(text.matchAll(QUOTED_SPAN), match => match.slice(1).find(Boolean).trim());
}

function draftTitles(draft) {
  const titles = [...quotedSpans(draft)];
  for (const line of draft.split(/\r?\n/u)) {
    const explicit = /^\s*(?:标题[：:]|#{1,6}\s+)\s*(.+)$/u.exec(line);
    const section = /^\s*(?:请)?(?:把|将|展开|修改|沿用|复用|按照)\s*([^，。；：\r\n]+?)\s*(?:这|那)一(?:节|段|部分)(?:[，。；\s]|$)/u.exec(line);
    if (explicit || section) titles.push((explicit || section)[1]);
  }
  return new Set(titles.map(bareTitle).filter(title => title.length > 0 && title.length <= 120));
}

function pathsIn(text) {
  const paths = new Set();
  for (const quoted of quotedSpans(text)) {
    if (!quoted.includes("://") && (
      /^(?:[a-z]:[\\/]|\.{1,2}[\\/]|[\\/])/iu.test(quoted)
      || /^[\p{L}\p{N}_ .@()+\[\]-]+(?:[\\/][\p{L}\p{N}_ .@()+\[\]-]+)+$/u.test(quoted)
      || /^[\p{L}\p{N}_.-]+\.[a-z][a-z0-9]{0,11}$/iu.test(quoted)
    )) paths.add(quoted);
  }
  const unquoted = text.replace(QUOTED_SPAN, " ").replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s<>`"']+/giu, " ");
  const path = /(?<![a-z0-9._\\/:-])(?:[a-z]:[\\/][a-z0-9_~.@%+-]+(?:[\\/][a-z0-9_~.@%+-]+)*|(?:\.{1,2}[\\/]|[\\/])?[a-z0-9_~.@%+-]+(?:[\\/][a-z0-9_~.@%+-]+)+)/giu;
  for (const match of unquoted.matchAll(path)) paths.add(match[0].replace(/\.+$/u, ""));
  return paths;
}

function replyLines(reply) {
  const lines = [];
  for (const { start, end, text, fence, startsListItem } of markdownLines(reply)) {
    const line = { start, end, text, code: Boolean(fence) };
    if (!fence || startsListItem) {
      const header = !fence && /^ {0,3}(#{1,6})\s+(.+)$/u.exec(text);
      const title = header ? bareTitle(header[2]) : bareTitle(text);
      const numbered = ORDERED_LINE.exec(header ? title : text) || ORDERED_LINE.exec(title);
      const bold = !fence && /^\s*\*\*.+\*\*\s*$/u.test(text);
      if (header || bold) line.level = header ? header[1].length : 6;
      if (numbered) line.number = normalizeNumber(numbered[2]);
      if (!fence && (line.level || line.number)) line.title = bareTitle(numbered ? numbered[3] : title);
      if (line.number) line.indent = (numbered?.[1] || "").replaceAll("\t", "    ").length;
    }
    lines.push(line);
  }
  return lines;
}

function headingsAndItems(lines) {
  const blocks = [];
  const headingsAtLevel = Array(7).fill(lines.length);
  const items = [];
  let nextHeading = lines.length;
  // 从尾部收集后继边界。标题只有六级，列表每项最多入栈、出栈各一次。
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (!line.level && !line.number) continue;
    let end = lines.length;
    if (line.level) {
      for (let level = 1; level <= line.level; level++) end = Math.min(end, headingsAtLevel[level]);
      headingsAtLevel[line.level] = index;
      nextHeading = index;
      items.length = 0;
    } else {
      while (items.length && items.at(-1).indent > line.indent) items.pop();
      end = items.at(-1)?.index ?? nextHeading;
      items.push({ index, indent: line.indent });
    }
    blocks.push({ start: line.start, end: lines[end - 1].end, title: line.title, number: line.number });
  }
  return blocks;
}

function paragraphs(lines, reply) {
  const blocks = [];
  let begin = null;
  function flush(end) {
    if (begin === null) return;
    blocks.push({ start: begin, end, paths: pathsIn(reply.slice(begin, end)) });
    begin = null;
  }
  for (const line of lines) {
    if (line.level || line.number || (!line.code && !line.text.trim())) flush(line.start);
    if (line.code || line.text.trim()) begin ??= line.start;
  }
  if (lines.length) flush(lines.at(-1).end);
  return blocks;
}

function appendUnique(blocks, keys, selects, matches) {
  for (const key of keys) {
    const matchingBlocks = blocks.filter(block => selects(block, key));
    if (matchingBlocks.length > 1) return false;
    if (matchingBlocks.length === 1) matches.push(matchingBlocks[0]);
  }
  return true;
}

function selectReplyExcerpt(reply, draft) {
  if (typeof reply !== "string" || typeof draft !== "string" || !reply.trim() || !draft.trim()) return "";
  if (reply.length <= MAX_REPLY_CHARS) return reply;
  // 快捷键在输入界面运行。超大正文或异常多的锚点直接跳过上下文，避免阻塞输入。
  if (reply.length > MAX_EXCERPT_SOURCE_CHARS || draft.length > MAX_EXCERPT_SOURCE_CHARS) return "";

  const numbers = new Set(Array.from(draft.matchAll(DRAFT_NUMBER), match => normalizeNumber(match[1] || match[2])).filter(Boolean));
  const titles = draftTitles(draft);
  const paths = pathsIn(draft);
  const count = numbers.size + titles.size + paths.size;
  if (!count || count > MAX_EXCERPT_ANCHORS) return "";

  const lines = replyLines(reply);
  const sections = numbers.size || titles.size ? headingsAndItems(lines) : [];
  const matches = [];
  if (!appendUnique(sections, numbers, (block, key) => block.number === key, matches)
    || !appendUnique(sections, titles, (block, key) => block.title === key, matches)
    || (paths.size > 0 && !appendUnique(paragraphs(lines, reply), paths, (block, key) => block.paths.has(key), matches))) return "";

  // 明确的标题、编号和路径若指向同一个区域，使用它们共同覆盖的完整段落。
  const target = matches.reduce((smallest, block) =>
    !smallest || block.end - block.start < smallest.end - smallest.start ? block : smallest, null);
  if (!target || matches.some(block => target.start < block.start || target.end > block.end)) return "";
  const excerpt = reply.slice(target.start, target.end).trimEnd();
  return excerpt.length <= MAX_REPLY_CHARS ? excerpt : "";
}

module.exports = { MAX_REPLY_CHARS, readLatestTurn, selectReplyExcerpt };
