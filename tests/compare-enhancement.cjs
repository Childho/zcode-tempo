"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { parseArgs } = require("node:util");
const { generateEnhancement } = require("../src/enhance-request.cjs");
const { ENHANCEMENT_PROMPT } = require("../src/enhancement-prompt.cjs");
const { findMissingProtectedText } = require("../src/enhancement-fidelity.cjs");

async function runVariant({ providerId, modelId, resourcesPath }, draft, variant) {
  const started = performance.now();
  const result = await generateEnhancement({ providerId, modelId, resourcesPath, text: draft },
    variant === "new" ? ENHANCEMENT_PROMPT : undefined);
  const latencyMs = Math.round(performance.now() - started);
  if (!result.ok) return { ok: false, kind: result.kind, latencyMs };
  const missing = findMissingProtectedText(draft, result.text);
  return {
    ok: true,
    text: result.text,
    serverModel: result.serverModel,
    latencyMs,
    usage: result.usage,
    missing,
    wouldWrite: variant === "old" || missing.length === 0,
  };
}

async function main() {
  const { values } = parseArgs({ options: {
    provider: { type: "string" }, model: { type: "string" }, resources: { type: "string" },
    output: { type: "string" }, concurrency: { type: "string", default: "3" },
  } });
  const providerId = values.provider;
  const modelId = values.model;
  const concurrency = Number(values.concurrency);
  assert.ok(providerId && modelId && values.output, "需要 --provider、--model 和 --output");
  assert.ok(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 6, "--concurrency 需为 1–6");
  const cases = require("./fixtures/enhancement-cases.json");
  assert.ok(cases.length > 0 && new Set(cases.map((item) => item.id)).size === cases.length, "草稿用例不能为空或重复");
  const target = { providerId, modelId, resourcesPath: values.resources };
  const results = new Array(cases.length);
  let nextIndex = 0;
  let completed = 0;

  async function worker() {
    while (nextIndex < cases.length) {
      const index = nextIndex++;
      const { id, draft, checks, type } = cases[index];
      const first = index % 2 === 0 ? "old" : "new";
      const second = first === "old" ? "new" : "old";
      const runs = {
        [first]: await runVariant(target, draft, first),
        [second]: await runVariant(target, draft, second),
      };
      results[index] = { id, type, draft, checks, old: runs.old, new: runs.new };
      completed++;
      console.log(`${completed}/${cases.length} ${id} old=${runs.old.ok ? "ok" : runs.old.kind} new=${runs.new.ok ? "ok" : runs.new.kind}`);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  const models = [...new Set(results.flatMap(({ old, new: next }) => [old.serverModel, next.serverModel].filter(Boolean)))];
  const failed = results.filter(({ old, new: next }) => !old.ok || !next.ok).length;
  await fs.writeFile(values.output, JSON.stringify({
    modelId, serverModels: models, pairedCases: cases.length, failedPairs: failed, results,
  }, null, 2) + "\n", "utf8");
  if (models.length !== 1 || failed) {
    console.error(`对照存在 ${failed} 个失败配对，响应模型数为 ${models.length}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
