"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { findMissingProtectedText } = require("../src/enhancement-fidelity.cjs");

test("allows ordinary prose to be rephrased without interpreting words or numbers as literals", () => {
  assert.deepEqual(findMissingProtectedText("先分析两种做法，说明 3 个主要差异", "比较两种做法，归纳最重要的三项区别"), []);
  assert.deepEqual(findMissingProtectedText("比较分析/执行和输入/输出", "比较不同的操作方式与数据流"), []);
  assert.deepEqual(findMissingProtectedText("检查src/server.ts里的逻辑", "检查 `src/server.ts` 里的逻辑"), []);
});

test("preserves complete fenced code including indentation and handles longer fence delimiters", () => {
  const original = "检查这段样例。\r\n````js\r\nconst label = `demo`;\r\n  console.log(label);\r\n````";
  const sameCode = "说明这段样例的行为。\n~~~javascript\nconst label = `demo`;\n  console.log(label);\n~~~";
  assert.deepEqual(findMissingProtectedText(original, sameCode), []);
  assert.deepEqual(findMissingProtectedText(original, sameCode.replace("  console", "console")), [
    { kind: "fence", value: "const label = `demo`;\n  console.log(label);" },
  ]);
});

test("protects exact inline literals but accepts a plain literal with token boundaries", () => {
  assert.deepEqual(findMissingProtectedText("检查 `authToken` 和 `` `login` ``。", "Check authToken. Preserve `` `login` ``."), []);
  assert.deepEqual(findMissingProtectedText("检查 `authToken`。", "检查 `authTokenBackup`。"), [
    { kind: "inline", value: "authToken" },
  ]);
  assert.deepEqual(findMissingProtectedText("检查 `authToken`。", "Review authToken.backup."), [
    { kind: "inline", value: "authToken" },
  ]);
});

test("accepts standalone commands wrapped in Markdown but flags arguments added, removed, or replaced", () => {
  const command = "npm test -- --watch=false";
  assert.deepEqual(findMissingProtectedText(command, `执行 \`${command}\`。`), []);
  assert.deepEqual(findMissingProtectedText(`执行 \`${command}\`。`, `$ ${command}`), []);
  assert.deepEqual(findMissingProtectedText(command, `~~~sh\n${command}\n~~~`), []);
  assert.deepEqual(findMissingProtectedText(command, `- ${command}`), []);

  for (const altered of ["npm test", `${command} --coverage`, "npm test -- --watch=true", `${command} && npm run build`]) {
    assert.deepEqual(findMissingProtectedText(command, altered), [{ kind: "command", value: command }]);
    assert.deepEqual(findMissingProtectedText(`运行 \`${command}\``, `运行 \`${altered}\``), [
      { kind: "inline", value: command },
    ]);
  }
});

test("preserves URLs while ignoring outer punctuation and requires the full query string", () => {
  const url = "https://example.test/a_(b)?mode=check#details";
  assert.deepEqual(findMissingProtectedText(`参阅 ${url}。`, `参阅[指南](${url})。`), []);
  assert.deepEqual(findMissingProtectedText(`See (${url}).`, `Read \`${url}\`.`), []);
  assert.deepEqual(findMissingProtectedText(url, `${url}-old`), [{ kind: "url", value: url }]);
  assert.deepEqual(findMissingProtectedText(url, url.replace("check", "create")), [{ kind: "url", value: url }]);
});

test("preserves high-confidence relative, POSIX, Windows and quoted Windows paths", () => {
  const paths = ["src/server.ts", "./tools/ci", "/opt/app/config.json", String.raw`E:\项目归档\store\draft.json`, String.raw`\\host\share\config.json`, String.raw`C:\Program Files\ZCode\config.json`];
  const original = `核对 ${paths.slice(0, -1).join("、")} 和 "${paths.at(-1)}"。`;
  assert.deepEqual(findMissingProtectedText(original, `检查 ${paths.map((path) => `\`${path}\``).join(" 与 ")}。`), []);
  assert.deepEqual(findMissingProtectedText(original, original.replace("src/server.ts", "src/server.ts.bak")), [
    { kind: "path", value: "src/server.ts" },
  ]);
  assert.deepEqual(findMissingProtectedText(original, original.replace("Program Files", "Program Files (x86)")), [
    { kind: "path", value: paths.at(-1) },
  ]);
});

test("reports a repeated literal once and keeps diagnostics local to the caller", () => {
  assert.deepEqual(findMissingProtectedText("`checkFlag` 和 `checkFlag`", "Check flags"), [
    { kind: "inline", value: "checkFlag" },
  ]);
});
