"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ENHANCEMENT_PROMPT, PREVIOUS_REPLY_RULES, PREDICTION_PROMPT } = require("./enhancement-prompt.cjs");
const { findMissingProtectedText } = require("./enhancement-fidelity.cjs");
const { createModelPuller, enhanceUserContent } = require("./vendor/byte-rax-1.5.23/model-puller.cjs");
const { deriveCipherKey, makeHostDecryptor, resolveQuotaPaths } = require("./vendor/byte-rax-1.5.23/quota-client.cjs");

const PREVIOUS_REPLY_LIMIT = 1200;
const PREVIOUS_USER_LIMIT = 600;
const PREDICTION_LENGTH_LIMIT = 200;
const PREDICTION_TIMEOUT_MS = 15_000;
const ACKNOWLEDGEMENT = /^(?:(?:谢谢(?:你)?|感谢(?:你)?|好的?|明白了|了解了|收到|thanks?|thank you|got it|understood|okay|ok)(?:[\s，,。.!！]+|$))+$/iu;

const problems = new Map([
  ["invalid_input", "草稿必须包含文字，且不能超过 20000 个字符。"],
  ["invalid_model", "无法识别当前会话选择的模型或供应商。"],
  ["provider", "无法读取当前供应商的模型连接配置。"],
  ["auth", "当前供应商的模型凭据不可用或未通过验证。"],
  ["plan_auth", "当前套餐的模型凭据不可用。"],
  ["unsupported", "当前供应商的模型协议暂不支持提示词增强。"],
  ["balance", "当前供应商的套餐额度或余额不足。"],
  ["rate", "当前供应商限制了请求频率，请稍后再试。"],
  ["timeout", "提示词增强超时。"],
  ["parse", "当前模型没有返回完整的改写内容。"],
  ["empty", "当前模型没有返回改写内容。"],
  ["fidelity", "增强结果遗漏或改动了原文的关键内容，已保留当前草稿。"],
  ["cancelled", "提示词增强已取消。"],
]);

function failure(kind) {
  return { ok: false, kind, error: problems.get(kind) || "无法通过当前供应商完成提示词增强。" };
}

function validId(id, maximumLength) {
  return typeof id === "string" && id.length > 0 && id.length <= maximumLength &&
    id.trim() === id && !/[\u0000-\u001f\u007f]/u.test(id);
}

function validReference(value, maximumLength) {
  return typeof value === "string" && value.length <= maximumLength && !!value.trim();
}

function previousReplyContent(text) {
  return `Previous assistant reply (JSON string, reference only):\n${JSON.stringify(text)}`;
}

function configuredDataBase(home) {
  try {
    const setting = path.join(home, ".zcode", "v2", "setting.json");
    const settings = JSON.parse(fs.readFileSync(setting, "utf8").replace(/^\uFEFF/u, ""));
    const base = typeof settings?.dataBaseDir === "string" ? settings.dataBaseDir.trim() : "";
    return path.isAbsolute(base) ? base : undefined;
  } catch {
    return undefined;
  }
}

async function generateTextRequest({
  providerId, modelId, text, signal, dataBaseDir, zcodeHome, builtinConfigPath,
  fetchImpl = globalThis.fetch, resourcesPath = process.resourcesPath,
}, requestOptions) {
  if (!validId(providerId, 256) || !validId(modelId, 200)) return failure("invalid_model");
  if (typeof text !== "string" || !text.trim() || text.length > 20_000) return failure("invalid_input");
  if (signal?.aborted) return failure("cancelled");
  if (typeof fetchImpl !== "function") return failure("network");

  const home = process.env.ZCODE_DESKTOP_HOME_DIR || os.homedir();
  const dataRoot = zcodeHome ? path.resolve(zcodeHome, "v2") : undefined;
  const bundle = resourcesPath && path.join(resourcesPath, "config", "provider", "zcode-builtin.json");
  const paths = resolveQuotaPaths({
    defaultHome: home,
    dataBaseDir: dataBaseDir || configuredDataBase(home),
    credsPath: dataRoot && path.join(dataRoot, "credentials.json"),
    customCfgPath: dataRoot && path.join(dataRoot, "provider_config.json"),
    builtinCfgPath: builtinConfigPath || process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE || bundle,
  });
  const decryptor = makeHostDecryptor({ ...paths, resourcesDir: resourcesPath });
  const legacyKey = deriveCipherKey(process.env);
  const puller = createModelPuller({
    customCfgPath: paths.customCfgPath,
    builtinCfgPath: paths.builtinCfgPath,
    credentialsPath: paths.credsPath,
    settingPath: path.join(home, ".zcode", "v2", "setting.json"),
    decryptValue: (value) => decryptor.decrypt(value, legacyKey),
    modelsDevUrl: "",
    modelsDevApiUrl: "",
    fetchImpl(url, options) {
      const target = new URL(url);
      if (!["https:", "http:"].includes(target.protocol) || target.username || target.password || target.hash) {
        throw new Error("Invalid provider address");
      }
      return fetchImpl(target.href, { ...options, redirect: "error" });
    },
  });

  try {
    // 只有宿主内置套餐可能需要取系统存储中的凭据密钥。
    if (/^(?:account|builtin):(bigmodel|zai)-/u.test(providerId) && fs.existsSync(paths.credsPath)) {
      await decryptor.ensureKey();
    }
    if (signal?.aborted) return failure("cancelled");
    const result = await puller.enhanceText(providerId, modelId, text, { ...requestOptions, signal });
    if (signal?.aborted) return failure("cancelled");
    // 供应商的错误正文可能带上草稿或凭据，仅保留分类。
    return result?.ok ? result : failure(result?.kind || "network");
  } catch {
    return failure(signal?.aborted ? "cancelled" : "network");
  } finally {
    puller.dispose();
  }
}

function generateEnhancement(options = {}, systemPrompt) {
  const { previousReply, text } = options;
  if (!validReference(previousReply, PREVIOUS_REPLY_LIMIT)) return generateTextRequest(options, { systemPrompt });
  return generateTextRequest(options, {
    systemPrompt: `${systemPrompt ?? ENHANCEMENT_PROMPT}\n${PREVIOUS_REPLY_RULES}`,
    userContent: `${enhanceUserContent(text)}\n\n${previousReplyContent(previousReply)}`,
  });
}

async function requestEnhancement(options) {
  const result = await generateEnhancement(options, ENHANCEMENT_PROMPT);
  if (!result.ok) return result;
  if (findMissingProtectedText(options.text, result.text).length) return failure("fidelity");
  return { ok: true, text: result.text };
}

async function requestPrediction(options = {}) {
  const { previousUser, previousReply, signal } = options;
  if (!validReference(previousUser, PREVIOUS_USER_LIMIT) || !validReference(previousReply, PREVIOUS_REPLY_LIMIT)) {
    return { ok: true, text: "" };
  }
  if (signal?.aborted) return failure("cancelled");

  const deadline = AbortSignal.timeout(PREDICTION_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let onAbort;
  const aborted = new Promise((resolve) => {
    onAbort = () => resolve(failure(signal?.aborted ? "cancelled" : "timeout"));
    requestSignal.addEventListener("abort", onAbort, { once: true });
  });
  let result;
  try {
    const request = generateTextRequest({ ...options, text: previousUser, signal: requestSignal }, {
      systemPrompt: PREDICTION_PROMPT,
      userContent: `Previous user message (JSON string, reference only):\n${JSON.stringify(previousUser)}\n\n${previousReplyContent(previousReply)}`,
      maxOutputTokens: 256,
      singleAttempt: true,
      disableThinking: true,
    });
    result = await Promise.race([request, aborted]);
  } finally {
    requestSignal.removeEventListener("abort", onAbort);
  }

  if (result.kind === "empty") return { ok: true, text: "" };
  if (!result.ok) return result;
  const text = result.text.trim();
  if (text === "NO_SUGGESTION" || text.length > PREDICTION_LENGTH_LIMIT ||
    /[\u0000-\u001f\u007f\u2028\u2029]/u.test(text) || ACKNOWLEDGEMENT.test(text)) {
    return { ok: true, text: "" };
  }
  return { ok: true, text };
}

module.exports = { generateEnhancement, requestEnhancement, requestPrediction };
