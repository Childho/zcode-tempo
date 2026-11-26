"use strict";

const { markdownLines } = require("./markdown-fences.cjs");

const INLINE = /(?<![\\`])(`+)(?!`)(.+?)(?<!`)\1(?!`)/gu;
const COMMAND = /^(?:(?:npm|pnpm|yarn|bun)[ \t]+(?:test|run|ci|install|add|exec|build|lint|check|typecheck)\b|(?:git|docker|cargo|go|node|python3?|pytest|make|dotnet|rg|curl|npx|uv|Get-Content|Test-Path|Set-Location)[ \t]+\S|pytest$)/u;
const URL = /https?:\/\/[^\s<>"'`，。！？；、]+/giu;
const URL_WRAPPERS = new Map([[")", "("], ["]", "["], ["}", "{"]]);
const PATH_SEGMENT = String.raw`[\p{L}\p{N}_.~%+@-]+`;
const BARE_PATH_START = String.raw`[A-Za-z0-9_.~%+@-]+`;
const PATH_SEPARATOR = String.raw`[/\\]`;
const PATH_ROOT = String.raw`(?:[A-Za-z]:[/\\]|\\\\|\.\.?[/\\]|~/|/)`;
const PATH_PREFIX = String.raw`(?<![\p{L}\p{N}_./\\:-])`;
const PATH_SUFFIX = String.raw`(?![\p{L}\p{N}_/\\-])`;
const ROOTED_PATH = `${PATH_PREFIX}${PATH_ROOT}(?:${PATH_SEGMENT}${PATH_SEPARATOR})*${PATH_SEGMENT}${PATH_SEPARATOR}?${PATH_SUFFIX}`;
// 相对路径必须带扩展名，才允许把紧邻的中文识别为正文。
const RELATIVE_FILE = String.raw`(?:${PATH_PREFIX}|(?<=\p{Script=Han}))${BARE_PATH_START}(?:${PATH_SEPARATOR}${PATH_SEGMENT})*${PATH_SEPARATOR}${PATH_SEGMENT}\.[A-Za-z0-9]{1,12}(?:${PATH_SUFFIX}|(?=\p{Script=Han}))`;
const PATH = new RegExp(`${ROOTED_PATH}|${RELATIVE_FILE}`, "gu");
const QUOTED_PATH = new RegExp(String.raw`^${PATH_ROOT}[\p{L}\p{N}_ .~%+@()&'$/\\-]+$`, "u");

function readParts(text) {
  const fences = [];
  const inline = [];
  const plain = [];
  let codeLines = null;

  for (const line of markdownLines(text)) {
    if (line.fence === "code") {
      codeLines.push(line.code);
      continue;
    }
    if (codeLines) fences.push(codeLines.join("\n"));
    codeLines = line.fence === "open" ? [] : null;
    if (line.fence) continue;
    plain.push(line.text.replace(INLINE, (match, _ticks, value) => {
      // Markdown uses one space on both sides to protect literal backticks at the edges.
      inline.push(/^ .+ $/u.test(value) && value.trim() ? value.slice(1, -1) : value);
      return " ".repeat(match.length);
    }));
  }
  if (codeLines) fences.push(codeLines.join("\n"));
  return { fences, inline, plain };
}

function standaloneCommand(text) {
  const value = text.trim().replace(/^(?:>\s*)?(?:(?:[-*+]|\d{1,9}[.)])\s+)?(?:\$\s+)?/u, "");
  return COMMAND.test(value) ? value : null;
}

function stripUrlPunctuation(value, line, offset) {
  const beforePunctuation = value.replace(/[.,!?;:]+$/u, "");
  const unmatched = new Map();
  for (const [close, open] of URL_WRAPPERS) {
    unmatched.set(close, beforePunctuation.split(close).length - beforePunctuation.split(open).length);
  }
  let end = beforePunctuation.length;
  // 只有找到对应的外层定界符，才能认定其后的标点属于正文。
  while (offset > 0 && URL_WRAPPERS.get(beforePunctuation[end - 1]) === line[offset - 1]
    && unmatched.get(beforePunctuation[end - 1]) > 0) {
    const close = beforePunctuation[--end];
    unmatched.set(close, unmatched.get(close) - 1);
    offset -= 1;
  }
  if (end === beforePunctuation.length && /[?#]/u.test(value)) return value;
  return beforePunctuation.slice(0, end);
}

function collectLine(line, items, wrapped = false) {
  const command = standaloneCommand(line);
  if (command) {
    items.command.add(command);
    // Command arguments are already covered by the complete invocation in the original.
    if (!wrapped) return;
  }

  const withoutUrls = line.replace(URL, (match, offset) => {
    items.url.add(stripUrlPunctuation(match, line, offset));
    return " ".repeat(match.length);
  });
  if (wrapped && QUOTED_PATH.test(withoutUrls)) {
    items.path.add(withoutUrls);
    return;
  }
  const withoutQuotedPaths = withoutUrls.replace(/(["'])([^"'\r\n]+)\1/gu, (match, _quote, value) => {
    if (!QUOTED_PATH.test(value)) return match;
    items.path.add(value);
    return " ".repeat(match.length);
  });
  for (const [path] of withoutQuotedPaths.matchAll(PATH)) {
    items.path.add(path.replace(/[.]+$/u, ""));
  }
}

function protectedItems(parts, rewritten) {
  const items = {
    fence: new Set(parts.fences.filter(Boolean)),
    inline: new Set(parts.inline.filter((value) => value.trim())),
    command: new Set(),
    url: new Set(),
    path: new Set(),
  };
  for (const line of parts.plain) collectLine(line, items, rewritten);
  if (rewritten) {
    for (const inline of parts.inline) collectLine(inline, items, true);
    for (const fence of parts.fences) {
      for (const line of fence.split("\n")) collectLine(line, items, true);
    }
  }
  return items;
}

function containsLiteral(plain, value) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const boundary = String.raw`[\p{L}\p{N}_/\\:@=-]`;
  return new RegExp(String.raw`(?<!${boundary})${escaped}(?!${boundary}|\.[\p{L}\p{N}_])`, "u").test(plain);
}

function findMissingProtectedText(original, rewritten) {
  const required = protectedItems(readParts(original), false);
  const parts = readParts(rewritten);
  const found = protectedItems(parts, true);
  const plain = parts.plain.join("\n");
  const missing = [];

  for (const [kind, values] of Object.entries(required)) {
    for (const value of values) {
      if (found[kind].has(value)) continue;
      if (kind === "inline") {
        if (standaloneCommand(value) === value) {
          if (found.command.has(value)) continue;
        } else if (found.fence.has(value) || found.url.has(value) || found.path.has(value)
          || containsLiteral(plain, value)) {
          continue;
        }
      }
      missing.push({ kind, value });
    }
  }
  return missing;
}

module.exports = { findMissingProtectedText };
