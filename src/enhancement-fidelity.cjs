"use strict";

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
const INLINE = /(?<![\\`])(`+)(?!`)(.+?)(?<!`)\1(?!`)/gu;
const COMMAND = /^(?:(?:npm|pnpm|yarn|bun)[ \t]+(?:test|run|ci|install|add|exec|build|lint|check|typecheck)\b|(?:git|docker|cargo|go|node|python3?|pytest|make|dotnet|rg|curl|npx|uv|Get-Content|Test-Path|Set-Location)[ \t]+\S|pytest$)/u;
const URL = /https?:\/\/[^\s<>"'`，。！？；、]+/giu;
const PATH_SEGMENT = String.raw`[\p{L}\p{N}_.~%+@-]+`;
const BARE_PATH_START = String.raw`[A-Za-z0-9_.~%+@-]+`;
const PATH_SEPARATOR = String.raw`[/\\]`;
const PATH_ROOT = String.raw`(?:[A-Za-z]:[/\\]|\\\\|\.\.?[/\\]|~/|/)`;
const PATH = new RegExp(
  String.raw`(?<![\p{L}\p{N}_./\\:-])(?:${PATH_ROOT}(?:${PATH_SEGMENT}${PATH_SEPARATOR})*${PATH_SEGMENT}${PATH_SEPARATOR}?|${BARE_PATH_START}(?:${PATH_SEPARATOR}${PATH_SEGMENT})*${PATH_SEPARATOR}${PATH_SEGMENT}\.[A-Za-z0-9]{1,12})(?![\p{L}\p{N}_/\\-])`,
  "gu"
);
const QUOTED_PATH = new RegExp(String.raw`^${PATH_ROOT}[\p{L}\p{N}_ .~%+@()&'$/\\-]+$`, "u");

function readParts(text) {
  const fences = [];
  const inline = [];
  const plain = [];
  let fence = null;

  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const marker = line.match(FENCE);
    if (fence) {
      if (marker && marker[1][0] === fence.marker[0] && marker[1].length >= fence.marker.length && !marker[2].trim()) {
        fences.push(fence.lines.join("\n"));
        fence = null;
      } else {
        fence.lines.push(line);
      }
      continue;
    }
    if (marker && (marker[1][0] === "~" || !marker[2].includes("`"))) {
      fence = { marker: marker[1], lines: [] };
      continue;
    }
    plain.push(line.replace(INLINE, (match, _ticks, value) => {
      // Markdown uses one space on both sides to protect literal backticks at the edges.
      inline.push(/^ .+ $/u.test(value) && value.trim() ? value.slice(1, -1) : value);
      return " ".repeat(match.length);
    }));
  }
  if (fence) fences.push(fence.lines.join("\n").replace(/\n$/u, ""));
  return { fences, inline, plain };
}

function standaloneCommand(text) {
  const value = text.trim().replace(/^(?:>\s*)?(?:[-*+]\s+)?(?:\$\s+)?/u, "");
  return COMMAND.test(value) ? value : null;
}

function stripUrlPunctuation(value) {
  let url = value.replace(/[.,!?;:]+$/u, "");
  for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
    const opens = url.split(open).length;
    let closes = url.split(close).length;
    while (url.endsWith(close) && closes > opens) {
      url = url.slice(0, -1);
      closes -= 1;
    }
  }
  return url;
}

function collectLine(line, items, wrapped = false) {
  const command = standaloneCommand(line);
  if (command) {
    items.command.add(command);
    // Command arguments are already covered by the complete invocation in the original.
    if (!wrapped) return;
  }

  const withoutUrls = line.replace(URL, (match) => {
    items.url.add(stripUrlPunctuation(match));
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
