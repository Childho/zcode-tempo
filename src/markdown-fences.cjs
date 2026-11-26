"use strict";

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
const LIST_ITEM = /^ {0,3}(?:[-+*]|\d{1,9}[.)]) {1,4}(?=\S)/u;

function tabWidth(column) {
  return 4 - column % 4;
}

function expandTabs(text) {
  let added = 0;
  return text.replaceAll("\t", (_tab, index) => {
    const width = tabWidth(index + added);
    added += width - 1;
    return " ".repeat(width);
  });
}

function removeIndent(text, columns) {
  // 仅移除容器缩进。代码正文的制表符保持原样。
  let index = 0;
  let consumed = 0;
  while (consumed < columns && (text[index] === " " || text[index] === "\t")) {
    consumed += text[index] === "\t" ? tabWidth(consumed) : 1;
    index++;
  }
  return " ".repeat(Math.max(0, consumed - columns)) + text.slice(index);
}

function* markdownLines(source) {
  const listIndents = [];
  let fence = null;
  let start = 0;

  for (const [raw] of source.matchAll(/[^\r\n]*(?:\r\n?|\n)|[^\r\n]+$/gu)) {
    const text = raw.replace(/(?:\r\n?|\n)$/u, "");
    const end = start + raw.length;
    const line = { start, end, text };
    start = end;
    const syntax = expandTabs(text);
    const leadingSpaces = syntax.match(/^ */u)[0].length;
    const blank = !syntax.trim();

    if (fence && (blank || leadingSpaces >= fence.listIndent)) {
      const marker = FENCE.exec(syntax.slice(fence.listIndent));
      if (marker && marker[1][0] === fence.marker[0] && marker[1].length >= fence.marker.length && !marker[2].trim()) {
        fence = null;
        yield { ...line, fence: "close" };
      } else {
        yield { ...line, fence: "code", code: removeIndent(text, fence.contentIndent) };
      }
      continue;
    }

    // 缩进退回到列表外时，围栏在前一行结束。这一行仍需按正文或新围栏解析。
    fence = null;
    if (!blank) {
      while ((listIndents.at(-1) ?? 0) > leadingSpaces) listIndents.pop();
    }
    let listIndent = listIndents.at(-1) ?? 0;
    let startsListItem = false;
    for (let item; (item = LIST_ITEM.exec(syntax.slice(listIndent)));) {
      listIndent += item[0].length;
      listIndents.push(listIndent);
      startsListItem = true;
    }
    const content = syntax.slice(listIndent);
    const marker = FENCE.exec(content);
    if (marker && (marker[1][0] === "~" || !marker[2].includes("`"))) {
      const contentIndent = listIndent ? listIndent + content.match(/^ */u)[0].length : 0;
      fence = { marker: marker[1], listIndent, contentIndent };
      yield { ...line, fence: "open", startsListItem };
    } else {
      yield line;
    }
  }
}

module.exports = { markdownLines };
