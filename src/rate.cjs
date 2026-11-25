"use strict";

/* 字符增量、会话回合及最终速率口径改编自 ByteRax ZCodeBox v1.5.23 的 turn-stats.js（MIT）。 */

const COMPOSER = '[data-testid="v4-composer"]';
const SURFACE = `${COMPOSER} .chat-composer-input-surface`;
const PANE = '[data-session-pane-root][data-session-id]';
const CONTEXT = '[data-testid="chat-context-usage-trigger"]';
const MODEL = '[data-testid="chat-model-select-trigger"]';
const COMPLETE = new Set(['completedSuccess', 'completedInterrupted', 'failed']);
const SAMPLE_WINDOW_MS = 2000;
const DEFAULT_CHARS_PER_TOKEN = 2;

function isCommitted(fiber) {
  let root = fiber;
  while (root.return) root = root.return;
  return root.stateNode?.current === root;
}

function getComposerProps(element) {
  const composer = element?.closest?.(COMPOSER);
  const pane = composer?.closest(PANE);
  if (!pane) return null;

  const paneSessionId = pane.getAttribute('data-session-id');
  const sessionId = paneSessionId === 'draft' ? null : paneSessionId;
  const projectedSeq = pane.getAttribute('data-projection-seq');
  const key = Object.keys(composer).find(name => name.startsWith('__reactFiber$'));
  let fiber = key && composer[key];
  let fallback = null;
  while (fiber) {
    for (const candidate of [fiber, fiber.alternate]) {
      const props = candidate?.memoizedProps;
      if (!props || typeof props.composerDraftScopeToken !== 'symbol' || props.sessionId !== sessionId) continue;
      if (projectedSeq && String(props.snapshot?.seq ?? '') !== projectedSeq) continue;
      if (isCommitted(candidate)) return props;
      fallback ??= props;
    }
    fiber = fiber.return;
  }
  return fallback;
}

// 与宿主的流式投影一致，一个 Unicode 码点记为一个字符。
function countCodePoints(text) {
  let count = text.length;
  for (let index = 0; index + 1 < text.length; index++) {
    const leading = text.charCodeAt(index);
    const trailing = text.charCodeAt(index + 1);
    if (leading >= 0xD800 && leading <= 0xDBFF && trailing >= 0xDC00 && trailing <= 0xDFFF) {
      count--;
      index++;
    }
  }
  return count;
}

function newReading() {
  return {
    snapshot: null,
    turnKey: null,
    characterCounts: new Map(),
    charsPerToken: DEFAULT_CHARS_PER_TOKEN,
    samples: [],
    finalRate: null,
    phase: 'unknown',
  };
}

function completedModelTime(header, tools) {
  if (Number.isFinite(header.modelDurationMs) && header.modelDurationMs > 0) return header.modelDurationMs;

  // ZCode 普通会话的回合没有 modelDurationMs，使用宿主工时减去前台工具时间。
  if (!Number.isFinite(header.activeMs)) return null;
  if (Number.isFinite(header.toolDurationMs)) return header.activeMs - header.toolDurationMs;

  const intervals = [];
  for (const tool of tools) {
    if (tool.backgrounded || (tool.status === 'cancelled' && tool.startedAt === undefined)) continue;
    if (!Number.isFinite(tool.startedAt) || !Number.isFinite(tool.endedAt) || tool.endedAt < tool.startedAt) return null;
    intervals.push([tool.startedAt, tool.endedAt]);
  }
  intervals.sort((first, next) => first[0] - next[0]);
  let toolMs = 0;
  let previousEnd = -Infinity;
  for (const [start, end] of intervals) {
    toolMs += Math.max(0, end - Math.max(start, previousEnd));
    previousEnd = Math.max(previousEnd, end);
  }
  return header.activeMs - toolMs;
}

function updateReading(reading, snapshot, now) {
  if (snapshot === reading.snapshot) return;
  const previous = reading.snapshot;
  reading.snapshot = snapshot;

  const rows = snapshot?.rows?.window;
  const header = Array.isArray(rows) && rows.findLast(row => row?.kind === 'turnHeader');
  if (!header) {
    reading.phase = 'unknown';
    reading.samples = [];
    return;
  }

  const turnKey = header.productTurnId || header.turnId;
  const modelChanged = previous?.config?.model !== snapshot.config?.model ||
    previous?.config?.provider !== snapshot.config?.provider;
  if (modelChanged) reading.charsPerToken = DEFAULT_CHARS_PER_TOKEN;
  if (turnKey !== reading.turnKey || previous?.logEpoch !== snapshot.logEpoch) {
    reading.turnKey = turnKey;
    reading.characterCounts.clear();
    reading.samples = [];
  }

  let characters = 0;
  let latest = null;
  const seen = new Set();
  const tools = [];
  for (const row of rows) {
    if (!row || (row.productTurnId || row.turnId) !== turnKey || row.kind === 'turnHeader') continue;
    const isOutput = row.kind === 'assistantText' || row.kind === 'reasoning';
    const isTool = row.kind === 'toolCall' || row.kind === 'subagent';
    const isActivity = isOutput || (isTool && !row.backgrounded);
    if (isTool) tools.push(row);
    if (isActivity && (!latest || latest.rowId < row.rowId)) latest = row;
    const text = isOutput ? row.text : row.kind === 'toolCall' ? row.inputText : null;
    if (typeof text !== 'string') continue;
    seen.add(row.rowId);
    let cached = reading.characterCounts.get(row.rowId);
    if (!cached || cached.text !== text) {
      cached = { text, count: countCodePoints(text) };
      reading.characterCounts.set(row.rowId, cached);
    }
    characters += cached.count;
  }
  for (const id of reading.characterCounts.keys()) {
    if (!seen.has(id)) reading.characterCounts.delete(id);
  }

  if (COMPLETE.has(header.state)) {
    const tokens = header.outputTokens;
    const modelMs = completedModelTime(header, tools);
    reading.finalRate = Number.isFinite(tokens) && tokens > 0 && Number.isFinite(modelMs) && modelMs > 0
      ? tokens * 1000 / modelMs
      : null;
    if (reading.finalRate !== null && tokens >= 12 && characters > 0) {
      reading.charsPerToken = Math.max(0.5, Math.min(8, characters / tokens));
    }
    reading.phase = 'complete';
    reading.samples = [];
    return;
  }

  const toolWaiting = (latest?.kind === 'toolCall' &&
    (latest.status === 'running' || latest.status === 'pendingApproval')) ||
    (latest?.kind === 'subagent' && latest.status === 'running');
  if (toolWaiting) {
    reading.phase = 'tool';
    reading.samples = [];
    return;
  }

  reading.phase = 'live';
  const samples = reading.samples;
  const last = samples.at(-1);
  if (last && (last.characters > characters || now - last.at > SAMPLE_WINDOW_MS)) samples.length = 0;
  if (!samples.length || last.characters !== characters) samples.push({ at: now, characters });
  while (samples.length > 2 && samples[1].at < now - SAMPLE_WINDOW_MS) samples.shift();
}

function formatReading(reading, now) {
  if (reading.phase === 'complete' && reading.finalRate !== null) return `${reading.finalRate.toFixed(1)} tok/s`;
  if (reading.phase === 'live' && reading.samples.length > 1) {
    const first = reading.samples[0];
    const last = reading.samples.at(-1);
    const elapsed = last.at - first.at;
    if (elapsed >= 80 && now - last.at <= SAMPLE_WINDOW_MS && last.characters > first.characters) {
      const estimate = (last.characters - first.characters) * 1000 / elapsed / reading.charsPerToken;
      return `${estimate.toFixed(1)} tok/s`;
    }
  }
  return '';
}

function createStatus(document) {
  const node = document.createElement('span');
  node.dataset.testid = 'harness-generation-rate';
  node.className = 'text-foreground-subtle';
  node.style.cssText = 'display:inline-flex;align-items:center;flex:none;white-space:nowrap;' +
    'font-size:12px;font-variant-numeric:tabular-nums;';
  return { node, sessionId: null, reading: newReading() };
}

function installRate({ window = globalThis.window, document = window.document } = {}) {
  const instances = new Map();
  let frame = null;
  let streamTimer = null;
  let disposed = false;

  function render() {
    frame = null;
    const now = window.performance.now();
    const current = new Set(document.querySelectorAll(SURFACE));
    for (const [surface, instance] of instances) {
      if (current.has(surface)) continue;
      instance.node.remove();
      instances.delete(surface);
    }

    let streams = false;
    for (const surface of current) {
      const pane = surface.closest(PANE);
      if (!pane) continue;
      let instance = instances.get(surface);
      if (!instance) {
        instance = createStatus(document);
        instances.set(surface, instance);
      }
      const sessionId = pane.getAttribute('data-session-id');
      if (sessionId !== instance.sessionId) {
        instance.sessionId = sessionId;
        instance.reading = newReading();
      }

      const snapshot = sessionId === 'draft' ? null : getComposerProps(surface)?.snapshot;
      if (snapshot?.sessionId === sessionId) updateReading(instance.reading, snapshot, now);
      const text = formatReading(instance.reading, now);
      const anchor = text && (surface.querySelector(CONTEXT) || surface.querySelector(MODEL));
      if (anchor) {
        if (instance.node.textContent !== text) instance.node.textContent = text;
        if (anchor.previousElementSibling !== instance.node) anchor.before(instance.node);
      } else {
        instance.node.remove();
      }
      if (instance.reading.phase === 'live' && instance.reading.samples.length > 1 &&
        now - instance.reading.samples.at(-1).at <= SAMPLE_WINDOW_MS) streams = true;
    }

    window.clearTimeout(streamTimer);
    if (streams) streamTimer = window.setTimeout(schedule, 300);
  }

  function schedule() {
    if (!disposed && frame === null) frame = window.requestAnimationFrame(render);
  }

  const observer = new window.MutationObserver(schedule);
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-session-id', 'data-session-generation', 'data-projection-seq'],
  });
  schedule();

  return () => {
    disposed = true;
    observer.disconnect();
    if (frame !== null) window.cancelAnimationFrame(frame);
    window.clearTimeout(streamTimer);
    for (const instance of instances.values()) instance.node.remove();
    instances.clear();
  };
}

module.exports = { getComposerProps, installRate };
