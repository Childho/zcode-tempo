"use strict";

/* 字符增量、会话回合及最终速率口径改编自 ByteRax ZCodeBox v1.5.23 的 turn-stats.js（MIT）。 */

const COMPOSER = '[data-testid="v4-composer"]';
const SURFACE = `${COMPOSER} .chat-composer-input-surface`;
const PANE = '[data-session-pane-root][data-session-id]';
const CONTEXT = '[data-testid="chat-context-usage-trigger"]';
const MODEL = '[data-testid="chat-model-select-trigger"]';
const COMPLETE = new Set(['completedSuccess', 'completedInterrupted', 'failed']);
const SAMPLE_WINDOW_MS = 2000;
const MIN_LIVE_SAMPLE_MS = 80;
const MIN_AVERAGE_SAMPLE_MS = 500;
const DEFAULT_CHARS_PER_TOKEN = 2;
const MAX_CACHED_TURNS = 64;
const HISTORY_PAGE_ROWS = 60;
const HISTORY_RETRY_DELAYS_MS = [1000, 3000];
const historyBoundaries = new WeakMap();
const RATE_TITLES = {
  live: '生成中实时估算',
  actual: '本轮实际均速',
  average: '本轮生成均速（估算）',
  partial: '本轮已计时请求均速',
  work: '本轮均速（含等待）',
  previous: '本会话最近均速（含等待）',
  estimated: '本轮最后一次实时估算',
};

function isCommitted(fiber) {
  let root = fiber;
  while (root.return) root = root.return;
  return root.stateNode?.current === root;
}

function elementFiber(element) {
  const key = Object.keys(element).find(name => name.startsWith('__reactFiber$'));
  return key && element[key];
}

function getComposerProps(element) {
  const composer = element?.closest?.(COMPOSER);
  const pane = composer?.closest(PANE);
  if (!pane) return null;

  const paneSessionId = pane.getAttribute('data-session-id');
  const sessionId = paneSessionId === 'draft' ? null : paneSessionId;
  const projectedSeq = pane.getAttribute('data-projection-seq');
  let fiber = elementFiber(composer);
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

function storeMatchesSnapshot(store, snapshot, expectedHistoryBoundary) {
  const current = store.getState()?.snapshot;
  return current?.sessionId === snapshot.sessionId && current.logEpoch === snapshot.logEpoch &&
    (current.seq === snapshot.seq || (expectedHistoryBoundary && historyBoundary(current) === expectedHistoryBoundary));
}

function getProjectionStore(pane, snapshot, expectedHistoryBoundary) {
  // SessionPane 通过宿主的 PluginUiSessionProvider 暴露同一会话的投影 store。
  for (let fiber = elementFiber(pane); fiber; fiber = fiber.return) {
    for (const candidate of [fiber, fiber.alternate]) {
      const props = candidate?.memoizedProps;
      const store = props?.projectionStore;
      if (props?.sessionId === snapshot.sessionId && !props.remoteSessionId &&
        typeof store?.transport?.rowsRange === 'function' && typeof store.getState === 'function' &&
        isCommitted(candidate) && storeMatchesSnapshot(store, snapshot, expectedHistoryBoundary)) return store;
    }
  }
  return null;
}

function telemetryScope(pane) {
  for (let fiber = elementFiber(pane); fiber; fiber = fiber.return) {
    for (const candidate of [fiber, fiber.alternate]) {
      const props = candidate?.memoizedProps;
      if (props?.remoteSessionId && isCommitted(candidate)) return null;
      const service = props?.services?.zcodeAgentService;
      if (props?.workspacePath && typeof service?.onDynamicConversationTelemetryFact === 'function' &&
        isCommitted(candidate)) {
        const { workspacePath, workspaceIdentity } = props;
        return { service, workspacePath, workspaceIdentity };
      }
    }
  }
  return null;
}

function remember(map, key, value) {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_CACHED_TURNS) map.delete(map.keys().next().value);
}

function measurementKey(sessionId, sourceCommandId) {
  return sourceCommandId && JSON.stringify([sessionId, sourceCommandId]);
}

function measuredRate(measurement, expectedTokens) {
  if (!measurement || measurement.hasTools || !(expectedTokens > 0)) return null;
  let reportedTokens = 0;
  let tokens = 0;
  let elapsed = 0;
  for (const request of measurement.requests.values()) {
    if (request.outputTokens === undefined) continue;
    reportedTokens += request.outputTokens;
    if (request.outputMs === undefined) continue;
    tokens += request.outputTokens;
    elapsed += request.outputMs;
  }
  // 回合累计用量校验是否拿到全部请求的首末增量和用量。
  if (elapsed <= 0 || reportedTokens > expectedTokens) return null;
  return { value: tokens * 1000 / elapsed, source: tokens === expectedTokens ? 'actual' : 'partial' };
}

function recordMeasurement(turnMeasurements, subscription, fact) {
  const kind = fact?.kind;
  if (kind !== 'model.request.status' && kind !== 'model.request.metrics' &&
    kind !== 'stream.chunk' && kind !== 'tool.lifecycle') return false;
  const key = fact.sessionId && measurementKey(fact.sessionId, fact.sourceCommandId);
  if (!key || !Number.isFinite(fact.occurredAt) || fact.parentToolCallId) return false;

  let turn = turnMeasurements.get(key);
  if (kind === 'stream.chunk') {
    const request = turn?.active;
    if (request?.subscription !== subscription || request.turnId !== fact.turnId ||
      !fact.chunkLength || fact.occurredAt < request.startedAt) return false;
    // firstChunk 按内容片段设置，同一个请求可以有多个首块。
    if (request.lastAt === undefined && !fact.firstChunk) request.missingFirstChunk = true;
    if (fact.occurredAt - request.lastAt > SAMPLE_WINDOW_MS) request.stalled = true;
    if (fact.channel === 'thought') request.sawThought = true;
    request.firstAt ??= fact.occurredAt;
    request.lastAt = Math.max(request.lastAt ?? fact.occurredAt, fact.occurredAt);
    return false;
  }

  if (kind !== 'tool.lifecycle' && (fact.querySource !== 'main_turn' || !fact.requestId)) {
    if (kind === 'model.request.status' && fact.status === 'model_request_started' && turn?.active) {
      turn.active.ambiguous = true;
    }
    return false;
  }
  if (!turn) {
    turn = { requests: new Map(), active: null, hasTools: false };
    remember(turnMeasurements, key, turn);
  }
  if (kind === 'tool.lifecycle') {
    if (turn.hasTools) return false;
    // 文本和思考事件不覆盖工具参数，不能把该回合标成全量实测。
    turn.hasTools = true;
    return true;
  }

  const existing = turn.requests.get(fact.requestId);
  if (kind === 'model.request.status') {
    if (fact.status === 'model_request_started' && !existing) {
      const request = { id: fact.requestId, turnId: fact.turnId, startedAt: fact.occurredAt, subscription };
      if (turn.active) {
        turn.active.ambiguous = true;
        request.ambiguous = true;
      }
      turn.requests.set(fact.requestId, request);
      turn.active = request;
    } else if (existing?.subscription === subscription && existing.turnId === fact.turnId) {
      if (fact.status === 'model_stream_stalled') existing.stalled = true;
      if (fact.status === 'model_request_completed') existing.completedAt = fact.occurredAt;
      if (turn.active === existing &&
        (fact.status === 'model_request_completed' || fact.status === 'model_request_failed' || fact.status === 'model_retry_scheduled')) {
        turn.active = null;
      }
    }
    return false;
  }

  if (!Number.isFinite(fact.outputTokens) || fact.outputTokens <= 0) return false;
  // 宿主可能先发布 completed 状态，再以同一序号发布指标。
  const request = existing || { id: fact.requestId };
  // 用量可能含供应商未流式发出的推理，正文计时无法覆盖这部分。
  const missingReasoning = fact.reasoningTokens > 0 && !request.sawThought;
  const observedCompletion = request.subscription === subscription && request.turnId === fact.turnId &&
    request.completedAt === fact.occurredAt;
  const outputMs = observedCompletion && !request.ambiguous && !request.stalled &&
    !request.missingFirstChunk && !missingReasoning &&
    request.lastAt <= fact.occurredAt && request.lastAt > request.firstAt
    ? request.lastAt - request.firstAt : undefined;
  if (request.outputMs !== undefined && !observedCompletion) return false;
  if (turn.active === request) turn.active = null;
  if (request.outputTokens === fact.outputTokens && request.outputMs === outputMs) return false;
  request.outputTokens = fact.outputTokens;
  request.outputMs = outputMs;
  turn.requests.set(fact.requestId, request);
  return true;
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
    header: null,
    turn: null,
    characterCounts: new Map(),
    charsPerToken: DEFAULT_CHARS_PER_TOKEN,
    characters: 0,
    samples: [],
    toolBoundary: null,
    completedRate: null,
    phase: 'unknown',
  };
}

function turnId(row) {
  return row.productTurnId || row.turnId;
}

function turnSampleKey(snapshot, id) {
  return JSON.stringify([snapshot.sessionId, snapshot.logEpoch, id]);
}

function isToolRow(row) {
  return row?.kind === 'toolCall' || row?.kind === 'subagent';
}

function isUnreadableToolRow(row) {
  return row?.kind === 'unreadable' && (row.sourceKind === 'toolCall' || row.sourceKind === 'subagent');
}

function completedModelTime(header, tools) {
  if (Number.isFinite(header.modelDurationMs) && header.modelDurationMs > 0) return header.modelDurationMs;

  // ZCode 普通会话的回合没有 modelDurationMs，使用宿主工时减去前台工具时间。
  if (!Number.isFinite(header.activeMs)) return null;
  if (Number.isFinite(header.toolDurationMs) && header.toolDurationMs >= 0) return header.activeMs - header.toolDurationMs;

  const intervals = [];
  for (const tool of tools) {
    if (isUnreadableToolRow(tool)) return null;
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

function completedTurnRate(header, tools) {
  const tokens = header.outputTokens;
  if (!Number.isFinite(tokens) || tokens <= 0) return null;
  const modelMs = completedModelTime(header, tools);
  if (!Number.isFinite(modelMs) || modelMs <= 0) return null;
  const rate = tokens * 1000 / modelMs;
  return Number.isFinite(rate) ? rate : null;
}

function previousCompletedRate(rows, latestHeaderIndex, toolsByTurn = new Map()) {
  // 从新到旧扫描，工具行可能要等到下一页才遇到同一轮的头部。
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index];
    if (!row) continue;
    const key = turnId(row);
    if (!key) continue;
    if (isToolRow(row) || isUnreadableToolRow(row)) {
      if (!toolsByTurn.has(key)) toolsByTurn.set(key, []);
      toolsByTurn.get(key).push(row);
      continue;
    }
    if (row.kind !== 'turnHeader') continue;
    const tools = toolsByTurn.get(key) || [];
    toolsByTurn.delete(key);
    if (index === latestHeaderIndex || !COMPLETE.has(row.state)) continue;
    const rate = completedTurnRate(row, tools);
    if (rate !== null) return rate;
  }
  return null;
}

function historyBoundary(snapshot) {
  if (historyBoundaries.has(snapshot)) return historyBoundaries.get(snapshot);
  const rows = snapshot?.rows;
  const window = rows?.window;
  const beforeRowId = window?.[0]?.rowId;
  if (!Number.isSafeInteger(rows?.firstRowId) || !(beforeRowId > rows.firstRowId)) return null;
  const latest = window.findLast(row => row?.kind === 'turnHeader');
  if (!COMPLETE.has(latest?.state)) return null;

  // 只比较会影响历史均速的已载内容，保留跨游标的工具行。本轮均速单独即时计算。
  const latestTurn = turnId(latest);
  const timingRows = [];
  for (const row of window) {
    if (!row || row === latest) continue;
    const rowTurn = turnId(row);
    if (row.kind === 'turnHeader') {
      timingRows.push([row.rowId, rowTurn, row.state, row.outputTokens, row.modelDurationMs, row.activeMs, row.toolDurationMs]);
    } else if (rowTurn === latestTurn) {
      continue;
    } else if (isUnreadableToolRow(row)) {
      timingRows.push([row.rowId, rowTurn, row.kind, row.sourceKind]);
    } else if (isToolRow(row) && !row.backgrounded) {
      timingRows.push([row.rowId, rowTurn, row.kind, row.status === 'cancelled', row.startedAt, row.endedAt]);
    }
  }
  const key = JSON.stringify([snapshot.sessionId, snapshot.logEpoch, rows.firstRowId, beforeRowId,
    latest.rowId, latestTurn, timingRows]);
  historyBoundaries.set(snapshot, key);
  return key;
}

async function readPreviousRate(store, snapshot, isCurrent) {
  const { firstRowId, window: rows } = snapshot.rows;
  let beforeRowId = rows[0].rowId;
  let minimumSeq = snapshot.seq;
  const toolsByTurn = new Map();
  const headerIndex = rows.findLastIndex(row => row?.kind === 'turnHeader');
  previousCompletedRate(rows, headerIndex, toolsByTurn);
  while (beforeRowId > firstRowId && isCurrent()) {
    const page = await store.transport.rowsRange({ sessionId: snapshot.sessionId, beforeRowId, limit: HISTORY_PAGE_ROWS });
    if (!isCurrent()) return null;
    if (page?.atLogEpoch !== snapshot.logEpoch || !Array.isArray(page.rows) ||
      (Number.isFinite(page.atSeq) && page.atSeq < minimumSeq)) throw new Error('历史页暂不可用');
    if (Number.isFinite(page.atSeq)) minimumSeq = page.atSeq;
    const older = page.rows.filter(row => Number.isSafeInteger(row?.rowId) && row.rowId >= firstRowId && row.rowId < beforeRowId);
    if (!older.length && page.hasMore !== false) throw new Error('历史页未推进游标');
    older.sort((first, second) => first.rowId - second.rowId);
    const rate = previousCompletedRate(older, -1, toolsByTurn);
    if (rate !== null || page.hasMore === false) return rate;
    beforeRowId = older[0].rowId;
  }
  return null;
}

function updateReading(reading, snapshot, clock, turnSamples, canObserve) {
  if (snapshot === reading.snapshot) return;
  const previous = reading.snapshot;
  reading.snapshot = snapshot;

  const rows = snapshot?.rows?.window;
  const headerIndex = Array.isArray(rows) ? rows.findLastIndex(row => row?.kind === 'turnHeader') : -1;
  if (headerIndex < 0) {
    // 冷加载长回合可能先收到尾段。只有尾窗能明确归属同一轮时才保留读数。
    const tail = Array.isArray(rows) && rows.at(-1);
    const id = tail && turnId(tail);
    const sameTurn = id && rows.every(row => !row || turnId(row) === id);
    reading.header = null;
    reading.turn = sameTurn ? turnSamples.get(turnSampleKey(snapshot, id)) : null;
    reading.phase = reading.turn ? 'waiting' : 'unknown';
    reading.characterCounts.clear();
    reading.characters = 0;
    reading.toolBoundary = null;
    reading.samples = [];
    return;
  }

  const header = rows[headerIndex];
  reading.header = header;
  const turnKey = turnId(header);
  const sampleKey = turnSampleKey(snapshot, turnKey);
  const modelChanged = previous?.config?.model !== snapshot.config?.model ||
    previous?.config?.provider !== snapshot.config?.provider;
  if (modelChanged) reading.charsPerToken = DEFAULT_CHARS_PER_TOKEN;
  if (reading.turn?.key !== sampleKey) {
    const turn = turnSamples.get(sampleKey) || {
      key: sampleKey, characters: 0, elapsed: 0, charsPerToken: reading.charsPerToken, lastRate: null, hasTools: false,
    };
    remember(turnSamples, sampleKey, turn);
    reading.turn = turn;
    reading.characterCounts.clear();
    reading.samples = [];
    reading.characters = 0;
    reading.toolBoundary = null;
  }

  let characters = 0;
  let latest = null;
  let toolBoundary = null;
  const seen = new Set();
  const tools = [];
  for (const row of rows) {
    if (!row || turnId(row) !== turnKey || row.kind === 'turnHeader') continue;
    const isOutput = row.kind === 'assistantText' || row.kind === 'reasoning';
    const isTool = isToolRow(row);
    const isActivity = isOutput || (isTool && !row.backgrounded);
    if (isTool || isUnreadableToolRow(row)) tools.push(row);
    if (((isTool && !row.backgrounded && row.status !== 'inputStreaming') || isUnreadableToolRow(row)) &&
      (toolBoundary === null || toolBoundary < row.rowId)) toolBoundary = row.rowId;
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

  const complete = COMPLETE.has(header.state);
  const toolWaiting = (latest?.kind === 'toolCall' &&
    (latest.status === 'running' || latest.status === 'pendingApproval')) ||
    (latest?.kind === 'subagent' && latest.status === 'running');
  const newToolBoundary = toolBoundary !== null && toolBoundary !== reading.toolBoundary;
  if (toolBoundary !== null) reading.toolBoundary = toolBoundary;
  const turn = reading.turn;
  if (tools.length) turn.hasTools = true;

  // 最后一批文字可能和完成态同帧。用宿主结束时刻为该批的时间上界。
  const now = clock.now();
  const endedAt = header.endedAt - clock.timeOrigin;
  const sampleAt = complete && Number.isFinite(endedAt) ? Math.min(now, endedAt) : now;
  sampleOutput(reading, characters, sampleAt, snapshot.seq, previous?.seq, canObserve && !toolWaiting, newToolBoundary);

  if (complete) {
    const actual = completedTurnRate(header, tools);
    if (actual !== null) {
      reading.completedRate = { value: actual, source: 'work' };
    } else {
      const previousRate = previousCompletedRate(rows, headerIndex);
      reading.completedRate = previousRate === null ? null : { value: previousRate, source: 'previous' };
    }
    reading.phase = 'complete';
    reading.samples = [];
    return;
  }

  reading.phase = toolWaiting ? 'waiting' : 'live';
}

function sampleOutput(reading, characters, now, seq, previousSeq, canObserve, newToolBoundary) {
  const { samples, turn } = reading;
  // 同一会话可有多个视图。串接采样前确认本视图见过最近已累计的投影。
  const isNewObservation = turn.seq === undefined || seq > turn.seq;
  const overlaps = isNewObservation && turn.seq > previousSeq;
  if (isNewObservation) turn.seq = seq;
  const added = characters > reading.characters;
  const shrank = characters < reading.characters;
  reading.characters = characters;
  const last = samples.at(-1);
  const elapsed = last ? now - last.at : 0;
  if (shrank || newToolBoundary || overlaps || !canObserve || elapsed > SAMPLE_WINDOW_MS || elapsed < 0) samples.length = 0;
  if (!canObserve || !added) return;
  if (samples.length) {
    if (elapsed === 0) return;
    if (isNewObservation) {
      turn.characters += characters - last.characters;
      turn.elapsed += elapsed;
    }
  }
  samples.push({ at: now, characters });
  while (samples.length > 2 && samples[1].at < now - SAMPLE_WINDOW_MS) samples.shift();
  const rate = liveEstimate(reading, now);
  if (rate !== null && isNewObservation) turn.lastRate = rate;
}

function liveEstimate(reading, now) {
  if (reading.samples.length < 2) return null;
  const first = reading.samples[0];
  const last = reading.samples.at(-1);
  const elapsed = last.at - first.at;
  if (elapsed < MIN_LIVE_SAMPLE_MS || now - last.at > SAMPLE_WINDOW_MS) return null;
  return (last.characters - first.characters) * 1000 / elapsed / reading.turn.charsPerToken;
}

function displayedRate(reading, now, measured) {
  const turn = reading.turn;
  const held = turn?.lastRate != null ? { value: turn.lastRate, source: 'estimated' } : null;
  if (reading.phase === 'complete') {
    if (measured?.source === 'actual') return measured;
    if (turn.elapsed >= MIN_AVERAGE_SAMPLE_MS) {
      return { value: turn.characters * 1000 / turn.elapsed / turn.charsPerToken, source: 'average' };
    }
    return held ?? measured ?? reading.completedRate;
  }

  if (reading.phase === 'waiting') return held;
  if (reading.phase !== 'live') return null;
  const value = liveEstimate(reading, now);
  return value === null ? held : { value, source: 'live' };
}

function createStatus(document) {
  const node = document.createElement('span');
  node.dataset.testid = 'harness-generation-rate';
  node.className = 'text-foreground-subtle';
  node.setAttribute('role', 'status');
  node.setAttribute('aria-live', 'off');
  node.style.cssText = 'display:inline-flex;align-items:center;flex:none;white-space:nowrap;' +
    'font-size:12px;font-variant-numeric:tabular-nums;';
  return { node, sessionId: null, reading: newReading(), history: null, telemetry: null };
}

function installRate({ window = globalThis.window, document = window.document, onComposer } = {}) {
  const instances = new Map();
  // 累计量按轮次保留，切换会话时只重新建立瞬时采样窗口。
  const turnSamples = new Map();
  const turnMeasurements = new Map();
  let frame = null;
  let streamTimer = null;
  let disposed = false;

  function observeRequests(pane, instance) {
    const scope = telemetryScope(pane);
    const current = instance.telemetry;
    if (current?.service === scope?.service && current?.workspacePath === scope?.workspacePath &&
      current?.workspaceIdentity === scope?.workspaceIdentity) return;
    current?.subscription?.dispose();
    instance.telemetry = null;
    if (!scope) return;

    const { service, workspacePath, workspaceIdentity } = scope;
    try {
      const binding = Symbol();
      const subscription = service.onDynamicConversationTelemetryFact({ workspacePath, workspaceIdentity })(fact => {
        if (!disposed && recordMeasurement(turnMeasurements, binding, fact)) schedule();
      });
      instance.telemetry = { ...scope, subscription };
    } catch {
      // 宿主计时不可用时仍可显示本轮的流式估算。
      instance.telemetry = scope;
    }
  }

  function clearHistory(instance) {
    const retryTimer = instance.history?.retryTimer;
    if (retryTimer != null) window.clearTimeout(retryTimer);
    instance.history = null;
  }

  function lookUpHistory(surface, pane, instance, snapshot, needsHistory) {
    const key = needsHistory && historyBoundary(snapshot);
    // store 可能早于 React 提交。等价历史边界可以安全复用，输入框的 seq 仍用于匹配会话。
    const store = key && getProjectionStore(pane, snapshot, key);
    if (!store) {
      clearHistory(instance);
      return;
    }
    // ZCode 在分支裁剪和完整快照替换时递增此修订值，游标相同时也要重查。
    const { turnNavigatorDirectoryRevision: revision } = store.getState();
    const previous = instance.history;
    if (previous?.store !== store || previous.key !== key || previous.revision !== revision) {
      clearHistory(instance);
      instance.history = { key, store, revision, value: null, attempts: 0, state: 'ready', retryTimer: null };
    }

    const history = instance.history;
    if (history.state !== 'ready') return;
    const isCurrent = () => {
      if (disposed || instances.get(surface) !== instance || instance.history !== history ||
        pane.getAttribute('data-session-id') !== snapshot.sessionId) return false;
      const current = store.getState();
      return current.turnNavigatorDirectoryRevision === revision && historyBoundary(current.snapshot) === key;
    };
    history.state = 'loading';
    history.attempts++;
    void readPreviousRate(store, snapshot, isCurrent).then(value => {
      if (!isCurrent()) {
        history.state = 'ready';
        return;
      }
      history.state = 'finished';
      history.value = value;
      if (value !== null) schedule();
    }).catch(() => {
      if (!isCurrent()) {
        history.state = 'ready';
        return;
      }
      const delay = HISTORY_RETRY_DELAYS_MS[history.attempts - 1];
      if (delay === undefined) {
        history.state = 'finished';
        return;
      }
      history.state = 'waiting';
      history.retryTimer = window.setTimeout(() => {
        history.retryTimer = null;
        history.state = 'ready';
        schedule();
      }, delay);
    });
  }

  function render() {
    frame = null;
    const now = window.performance.now();
    const current = new Set(document.querySelectorAll(SURFACE));
    for (const [surface, instance] of instances) {
      if (current.has(surface)) continue;
      clearHistory(instance);
      instance.telemetry?.subscription?.dispose();
      instance.node.remove();
      instances.delete(surface);
    }

    let streams = false;
    let activeSurface;
    let activeProps;
    for (const surface of current) {
      const pane = surface.closest(PANE);
      if (!pane) continue;
      let instance = instances.get(surface);
      if (!instance) {
        instance = createStatus(document);
        instances.set(surface, instance);
      }
      observeRequests(pane, instance);
      const sessionId = pane.getAttribute('data-session-id');
      if (sessionId !== instance.sessionId) {
        instance.sessionId = sessionId;
        instance.reading = newReading();
        clearHistory(instance);
      }

      const props = sessionId === 'draft' ? null : getComposerProps(surface);
      const snapshot = props?.snapshot;
      if (onComposer && pane.getAttribute('data-testid') === 'v4-session-pane-workspace-main') {
        activeSurface = surface;
        activeProps = props;
      }
      const { reading } = instance;
      const currentSnapshot = snapshot?.sessionId === sessionId;
      if (currentSnapshot) updateReading(reading, snapshot, window.performance, turnSamples, document.visibilityState !== 'hidden');
      const { sourceCommandId, outputTokens } = reading.header || {};
      const measurement = reading.phase === 'complete' && !reading.turn?.hasTools &&
        turnMeasurements.get(measurementKey(sessionId, sourceCommandId));
      const measured = measuredRate(measurement, outputTokens);
      if (measured?.source === 'actual' && outputTokens >= 12 && reading.characters > 0) {
        reading.charsPerToken = Math.max(0.5, Math.min(8, reading.characters / outputTokens));
      }
      const currentRate = displayedRate(reading, now, measured);
      if (currentSnapshot) lookUpHistory(surface, pane, instance, snapshot, reading.phase === 'complete' && !currentRate);
      const historicalRate = instance.history?.value;
      const rate = currentRate ?? (historicalRate == null ? null : { value: historicalRate, source: 'previous' });
      const anchor = rate && (surface.querySelector(CONTEXT) || surface.querySelector(MODEL));
      if (anchor) {
        const text = `${rate.value.toFixed(1)} tok/s`;
        const title = RATE_TITLES[rate.source];
        const label = `${title} ${text}`;
        if (instance.node.textContent !== text) instance.node.textContent = text;
        if (instance.node.title !== title) instance.node.title = title;
        if (instance.node.getAttribute('aria-label') !== label) instance.node.setAttribute('aria-label', label);
        if (anchor.previousElementSibling !== instance.node) anchor.before(instance.node);
      } else {
        instance.node.remove();
      }
      if (reading.phase === 'live' && reading.samples.length > 1 &&
        now - reading.samples.at(-1).at <= SAMPLE_WINDOW_MS) streams = true;
    }

    window.clearTimeout(streamTimer);
    if (streams) streamTimer = window.setTimeout(schedule, 300);
    onComposer?.(activeSurface, activeProps);
  }

  function schedule() {
    if (!disposed && frame === null) frame = window.requestAnimationFrame(render);
  }
  function resetSampleWindows() {
    for (const instance of instances.values()) instance.reading.samples = [];
    schedule();
  }

  const observer = new window.MutationObserver(schedule);
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-session-id', 'data-session-generation', 'data-projection-seq', 'disabled', 'contenteditable'],
  });
  document.addEventListener?.('compositionend', schedule, true);
  document.addEventListener?.('visibilitychange', resetSampleWindows);
  schedule();

  return () => {
    disposed = true;
    observer.disconnect();
    document.removeEventListener?.('compositionend', schedule, true);
    document.removeEventListener?.('visibilitychange', resetSampleWindows);
    if (frame !== null) window.cancelAnimationFrame(frame);
    window.clearTimeout(streamTimer);
    for (const instance of instances.values()) {
      clearHistory(instance);
      instance.telemetry?.subscription?.dispose();
      instance.node.remove();
    }
    instances.clear();
    turnSamples.clear();
    turnMeasurements.clear();
  };
}

module.exports = { getComposerProps, installRate };
