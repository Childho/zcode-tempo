"use strict";

// 输入框识别和富文本保护沿用 ByteRax v1.5.23 的增强接入。许可证见 vendor/。
const INPUT = '[data-testid="v4-composer-input"]';
const COMPOSER = '[data-testid="v4-composer"]';
const SESSION_PANE = "[data-session-pane-root]";
const LEADING_ACTIONS = '[data-composer-leading-actions]';
const FLOATING_HOST = '[data-testid="side-pane-full-view-host"]';
const FLOATING_COMPOSER = `${FLOATING_HOST}[data-side-pane-full-view-host="floating"]`;
const INLINE_COMPOSER = '[data-composer-layout="inline"]';
const ATTACHMENTS = '[data-testid^="v4-attachment-"], [data-composer-context-attachments-row], [data-composer-element-screenshots]';
const STATUS_ID = "harness-enhancement-status";
const STATUS = `[data-testid="${STATUS_ID}"]`;
const STATUS_SLOT = "harness-enhancement-status-slot";
const STATUS_ANCHOR = "harness-enhancement-status-anchor";
const PREDICTION_PREVIEW = "harness-prediction-preview";
const GESTURE_MS = 700;
const UNCHANGED_STATUS_MS = 1500;
const MAX_ENHANCEMENT_JOBS = 64;
const MAX_RECENT_PREDICTIONS = 64;

// 宽窗用原生按钮组后的余量，空间不足时借用工具栏上方已有的 12px 间距。
const STATUS_CSS = `
  ${LEADING_ACTIONS}:has(> .${STATUS_SLOT}) { position: relative; }
  .${STATUS_SLOT} {
    display: flex; align-items: center; align-self: stretch; flex: 1 1 0%;
    min-inline-size: 0; container: harness-enhancement-status / inline-size;
  }
  ${STATUS} {
    box-sizing: border-box; min-inline-size: 0; max-inline-size: 100%;
    padding-inline-start: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: color-mix(in oklab, var(--color-foreground-subtle) 88%, var(--color-foreground));
    font-size: 12px; line-height: 16px; pointer-events: none; user-select: none;
  }
  @container harness-enhancement-status (inline-size < 136px) {
    ${STATUS} {
      position: absolute; inset-inline-start: 0; bottom: 100%; max-inline-size: none;
      padding-inline-start: 0; line-height: 12px;
    }
  }
  .${STATUS_ANCHOR} { position: absolute; inset: 0; pointer-events: none; }
  ${FLOATING_HOST} > .${STATUS_SLOT} { display: none; }
  ${FLOATING_COMPOSER}:has(form > ${INLINE_COMPOSER}) > .${STATUS_SLOT} {
    position: absolute;
    inset-inline-end: calc(anchor(end) + 8px); bottom: anchor(top); z-index: 11;
    display: block; container: none; pointer-events: none;
  }
  ${FLOATING_COMPOSER} > .${STATUS_SLOT} ${STATUS} { display: block; padding-inline-start: 0; line-height: 12px; }
`;

function getEditor(input) {
  const api = input?.__zcodeLexicalInputE2E;
  const editor = input?.__lexicalEditor;
  if (!api || !editor || editor.getRootElement() !== input) return null;
  return { api, editor };
}

function readUnsentDraftKey(props, token) {
  // ZCode 4.0 用 Symbol(scopeKey) 标记输入框。重新挂载可能换 Symbol，新建任务还会递增草稿版本。
  const key = token.description;
  if (!key?.startsWith("[") || !props.rootDraftScopeKey) return null;
  try {
    const scope = JSON.parse(key);
    const workspaceKey = props.workspaceIdentity?.trim() || props.workspacePath;
    if (Array.isArray(scope) && scope.length === 4 && scope[0] === workspaceKey && scope[1] === "__draft__"
      && Number.isSafeInteger(scope[2]) && scope[2] >= 0 && scope[3] === props.rootDraftScopeKey) return key;
  } catch { /* 无法识别的宿主标识不用于跨挂载回填。 */ }
  return null;
}

function readDraftOwner(props) {
  if (!props || !props.workspacePath || props.isWebRemoteControl || props.remoteSessionId) return null;
  const token = props.composerDraftScopeToken;
  if (typeof token !== "symbol") return null;
  const workspace = JSON.stringify([props.workspacePath, props.workspaceIdentity || ""]);
  const sessionId = props.sessionId || "";
  return {
    workspace,
    sessionId,
    token,
    draftKey: sessionId ? null : readUnsentDraftKey(props, token),
  };
}

function isOriginalDraft(origin, visible) {
  if (!visible || origin.workspace !== visible.workspace) return false;
  if (origin.sessionId) return origin.sessionId === visible.sessionId;
  if (origin.token === visible.token) return true;
  return !visible.sessionId && origin.draftKey !== null && origin.draftKey === visible.draftKey;
}

function readSelectedModel(props) {
  try {
    const selection = typeof props.createSubmissionFromComposer === "function"
      ? props.createSubmissionFromComposer()?.modelSelection
      : props.draftConfig?.modelSelection || props.composerDraft?.modelSelection;
    return { providerId: selection?.providerId || "", modelId: selection?.modelId || "" };
  } catch {
    return { providerId: "", modelId: "" };
  }
}

function containsReferences(input, api) {
  const state = api.getEditorState?.();
  return /"type"\s*:\s*"prompt-mention"/.test(JSON.stringify(state) || "")
    || /\]\((?:file|plugin|skill|agent):\/\//.test(api.getText())
    || !!input.closest(COMPOSER)?.querySelector(ATTACHMENTS);
}

function caretAtEnd(window, input) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed || !input.contains(selection.focusNode)) return false;
  const tail = selection.getRangeAt(0).cloneRange();
  tail.setEnd(input, input.childNodes.length);
  return tail.toString().length === 0;
}

function setText(window, input, adapter, text, tag) {
  const tags = window.document.activeElement === input ? tag : [tag, "skip-dom-selection"];
  adapter.editor.update(() => adapter.api.setText(text), { tag: tags, discrete: true });
}

function canWrite(input, props) {
  return input.isConnected && input.getClientRects().length && props
    && !props.disabled && !props.blockingRequestId && !props.draftScopeId;
}

function installEnhancement({ window, document, getComposerProps, replyContext, request }) {
  const jobs = new Set();
  const unchanged = new Map();
  const floatingStatuses = new Map();
  const attemptedPredictions = new Set();
  let nextStatusAnchor = 0;
  let disposed = false;
  let gesture = null;
  let writeFrame = null;
  let statusFrame = null;
  let statusStyle = null;
  let rescan = false;
  let lastNotice = null;
  let noticeTimer = null;
  let observed = null;
  let foregroundSince = null;
  let prediction = null;
  let preview = null;
  let previewStyle = null;
  let previewFrame = null;

  function discardPrediction() {
    const previous = prediction;
    prediction = null;
    previous?.controller.abort();
    if (preview) {
      preview.remove();
      preview.textContent = "";
    }
  }

  function endForeground() {
    foregroundSince = null;
  }

  function isForeground() {
    return document.visibilityState !== "hidden" && document.hasFocus();
  }

  function updateForeground() {
    if (isForeground()) foregroundSince ??= Date.now();
    else endForeground();
  }

  function matchesPrediction(owner, turn, props) {
    return isOriginalDraft(prediction.owner, owner) && turn?.key === prediction.turnKey &&
      turn.state === "completedSuccess" && readSelectedModel(props).providerId === prediction.providerId;
  }

  function renderPredictionPreview() {
    previewFrame = null;
    const input = observed?.surface?.querySelector(INPUT);
    const props = input && getComposerProps(input);
    const owner = readDraftOwner(props);
    const adapter = getEditor(input);
    const text = owner?.sessionId && adapter && canWrite(input, props) && !adapter.editor.isComposing()
      && !adapter.api.getText().trim() && !containsReferences(input, adapter.api) && readyPrediction(owner, props);
    if (!text) {
      preview?.remove();
      return;
    }
    if (!preview) {
      // 灰字放在宿主占位文字的位置，独立于编辑器内容和撤销历史。
      preview = document.createElement("div");
      preview.dataset.testid = PREDICTION_PREVIEW;
      preview.setAttribute("aria-hidden", "true");
      preview.className = "text-ui-base leading-5 text-foreground";
      preview.style.cssText = "position:absolute;inset:0 0 auto;pointer-events:none;user-select:none;opacity:.55;" +
        "display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere";
      previewStyle = document.createElement("style");
      previewStyle.textContent = `[data-testid="${PREDICTION_PREVIEW}"] ~ ${INPUT} + [aria-hidden="true"] { visibility: hidden; }`;
      document.head.append(previewStyle);
    }
    if (preview.textContent !== text) preview.textContent = text;
    if (preview.nextElementSibling !== input) input.before(preview);
  }

  function schedulePredictionPreview() {
    if (previewFrame === null && (prediction?.text || preview?.isConnected)) {
      previewFrame = window.requestAnimationFrame(renderPredictionPreview);
    }
  }

  async function preparePrediction(owner, turn, model) {
    const controller = new window.AbortController();
    const entry = { owner, turnKey: turn.key, providerId: model.providerId, controller, text: "" };
    prediction = entry;
    const previousUser = turn.userText.trim().slice(0, 600).replace(/[\uD800-\uDBFF]$/u, "");
    const previousReply = turn.reply.trim().slice(-replyContext.MAX_REPLY_CHARS).replace(/^[\uDC00-\uDFFF]/u, "");
    try {
      const result = await request({ ...model, mode: "prediction", previousUser, previousReply }, { signal: controller.signal });
      if (prediction === entry && result?.ok && typeof result.text === "string") {
        entry.text = result.text.trim();
        schedulePredictionPreview();
      }
    } catch { /* 自动预测失败时不影响正常输入。 */ }
  }

  function observeComposer(surface, props) {
    if (disposed) return;
    pruneFloatingStatuses();
    const input = surface?.querySelector(INPUT);
    if (input) renderEnhancementStatus(input, true);
    schedulePredictionPreview();
    if (!isForeground()) {
      endForeground();
      return;
    }
    // 恢复后的首帧可能直接是完成态。用焦点事件确定完成时间，用失焦前的投影确认同一会话。
    const previous = foregroundSince === null ? null : observed;
    foregroundSince ??= Date.now();
    const snapshot = props?.snapshot;
    if (!previous?.pending && previous?.surface === surface && previous?.props === props && previous?.snapshot === snapshot) return;
    const owner = readDraftOwner(props);
    // 宿主可能先更新 DOM 再提交投影。只在同一个会话面板暂缺投影时保留上一帧。
    if (!snapshot && previous?.snapshot && previous.owner?.sessionId && previous.surface === surface &&
      (!owner || isOriginalDraft(previous.owner, owner)) &&
      surface?.closest(SESSION_PANE)?.getAttribute("data-session-id") === previous.owner?.sessionId) return;
    const turn = owner?.sessionId && replyContext?.readLatestTurn(snapshot, owner.sessionId);
    const sameSession = owner?.sessionId && previous?.owner && isOriginalDraft(previous.owner, owner) &&
      snapshot?.logEpoch === previous?.snapshot?.logEpoch;
    const sameTurn = sameSession && turn && turn.key === previous?.turn?.key;
    const newCompletion = sameSession && turn?.state === "completedSuccess" && (
      (sameTurn && previous.turn.state === "running") ||
      (!sameTurn && previous.turn && turn.rowId > previous.turn.rowId && snapshot.seq > previous.snapshot.seq));
    observed = {
      surface, props, snapshot, owner, turn,
      pending: turn?.state === "completedSuccess" && (newCompletion || (sameTurn && previous.pending)),
    };

    if (prediction && !matchesPrediction(owner, turn, props)) discardPrediction();
    if (!observed.pending) return;

    const adapter = getEditor(input);
    // 完成投影、输入框解锁和模型选择可能先后到达。临时未就绪时保留本轮完成事件。
    if (!adapter || !canWrite(input, props) || adapter.editor.isComposing()) return;
    if (adapter.api.getText().trim() || containsReferences(input, adapter.api)) {
      observed.pending = false;
      return;
    }
    // 结束状态和带操作标记的最终正文可能分开到达，等待同一轮的下一次投影。
    if (!turn.reply || !turn.userText || !turn.providerId || !Number.isFinite(turn.endedAt)) return;
    // 恢复后可能依次收到后台积压的运行和完成投影，用宿主的完成时间核对前台区间。
    if (turn.endedAt < foregroundSince) {
      observed.pending = false;
      return;
    }
    const model = readSelectedModel(props);
    if (!model.modelId || !model.providerId) return;
    observed.pending = false;
    if (model.providerId !== turn.providerId) return;
    const attemptKey = JSON.stringify([owner.workspace, turn.key]);
    if (attemptedPredictions.has(attemptKey)) return;
    attemptedPredictions.add(attemptKey);
    if (attemptedPredictions.size > MAX_RECENT_PREDICTIONS) attemptedPredictions.delete(attemptedPredictions.values().next().value);
    void preparePrediction(owner, turn, model);
  }

  function readyPrediction(owner, props) {
    if (!prediction?.text) return "";
    const turn = replyContext.readLatestTurn(props.snapshot, owner.sessionId);
    return matchesPrediction(owner, turn, props) ? prediction.text : "";
  }

  function pruneFloatingStatuses() {
    for (const [form, { anchor, slot }] of floatingStatuses) {
      const host = form.isConnected && form.closest(FLOATING_COMPOSER);
      if (host && anchor.parentElement === form && slot.parentElement === host) continue;
      anchor.remove();
      slot.remove();
      floatingStatuses.delete(form);
    }
  }

  function renderEnhancementStatus(input, mount = false) {
    const composer = input.closest(COMPOSER);
    if (!composer) return;
    const floatingHost = input.closest(FLOATING_COMPOSER);
    const form = floatingHost && input.closest(INLINE_COMPOSER)?.closest("form");
    const target = form ? floatingHost : composer.querySelector(LEADING_ACTIONS);
    if (!target) return;
    let status = form ? floatingStatuses.get(form)?.status : target.querySelector(`:scope > .${STATUS_SLOT} > ${STATUS}`);
    const owner = (jobs.size || unchanged.size) && input.getClientRects().length
      ? readDraftOwner(getComposerProps(input)) : null;
    const waiting = owner && [...jobs].some((job) => !job.noticeShown && isOriginalDraft(job.owner, owner));
    const completed = owner && [...unchanged.keys()].some((job) => isOriginalDraft(job.owner, owner));
    const message = waiting ? "正在增强…" : completed ? "增强完成，草稿未改动" : "";
    if (!status && (mount || message)) {
      if (!statusStyle) {
        statusStyle = document.createElement("style");
        statusStyle.textContent = STATUS_CSS;
        document.head.append(statusStyle);
      }
      status = document.createElement("span");
      status.dataset.testid = STATUS_ID;
      status.setAttribute("role", "status");
      status.className = "text-foreground-subtle";
      const statusSlot = document.createElement("span");
      statusSlot.className = STATUS_SLOT;
      statusSlot.append(status);
      if (form) {
        // 浮动状态区挂在裁剪层外，分屏中的每个表单使用各自的定位锚点。
        const anchor = document.createElement("span");
        const anchorName = `--harness-enhancement-composer-${++nextStatusAnchor}`;
        anchor.className = STATUS_ANCHOR;
        anchor.setAttribute("aria-hidden", "true");
        anchor.style.anchorName = anchorName;
        statusSlot.style.positionAnchor = anchorName;
        form.append(anchor);
        floatingStatuses.set(form, { anchor, slot: statusSlot, status });
      }
      target.append(statusSlot);
    }
    if (status && status.textContent !== message) status.textContent = message;
  }

  function scheduleEnhancementStatus() {
    if (statusFrame !== null) return;
    statusFrame = window.requestAnimationFrame(() => {
      statusFrame = null;
      pruneFloatingStatuses();
      for (const input of document.querySelectorAll(INPUT)) renderEnhancementStatus(input);
    });
  }

  function expireUnchanged(job) {
    window.clearTimeout(unchanged.get(job));
    unchanged.delete(job);
    if (!jobs.size && !unchanged.size) observer.disconnect();
    scheduleEnhancementStatus();
  }

  function notify(input, message) {
    if (!input.isConnected) return;
    lastNotice?.remove();
    if (noticeTimer !== null) window.clearTimeout(noticeTimer);
    const notice = document.createElement("div");
    notice.setAttribute("role", "status");
    notice.dataset.testid = "harness-enhancement-notice";
    notice.textContent = message;
    notice.style.cssText = "font-size:12px;color:inherit;padding:3px 8px;opacity:.85";
    input.closest(COMPOSER)?.append(notice);
    lastNotice = notice;
    noticeTimer = window.setTimeout(() => {
      notice.remove();
      lastNotice = null;
      noticeTimer = null;
    }, 4500);
  }

  function finish(job) {
    jobs.delete(job);
    if (!jobs.size && !unchanged.size) observer.disconnect();
    scheduleEnhancementStatus();
  }

  function writeResult(job, input, mountedToken) {
    if (!jobs.has(job) || !input.isConnected) return;
    const props = getComposerProps(input);
    const adapter = getEditor(input);
    if (!adapter || !canWrite(input, props) || props.composerDraftScopeToken !== mountedToken
      || !isOriginalDraft(job.owner, readDraftOwner(props)) || adapter.editor.isComposing()) return;
    if (containsReferences(input, adapter.api)) {
      if (!job.noticeShown) {
        job.noticeShown = true;
        renderEnhancementStatus(input);
        notify(input, "草稿中有引用或附件，移除后将回填增强结果");
      }
      return;
    }
    try {
      // 强制创建一条原生撤销记录，覆盖前的现有文本就是撤销目标。
      if (adapter.api.getText() !== job.text) setText(window, input, adapter, job.text, "history-push");
    } catch {
      notify(input, "增强结果写回失败，已保留草稿");
    }
    finish(job);
    renderEnhancementStatus(input);
  }

  function scheduleWrites() {
    if (!jobs.size) return;
    if (writeFrame !== null) {
      rescan = true;
      return;
    }
    const targets = new Map();
    for (const input of document.querySelectorAll(INPUT)) {
      if (!input.isConnected || !input.getClientRects().length) continue;
      const props = getComposerProps(input);
      const visible = readDraftOwner(props);
      for (const job of jobs) {
        if (!isOriginalDraft(job.owner, visible)) continue;
        // 仅接纳宿主保留了同一草稿标识的首发迁移，预热会话可以被新草稿复用。
        if (!job.owner.sessionId) {
          job.owner.token = visible.token;
          job.owner.sessionId = visible.sessionId;
        }
        if (job.text !== undefined && canWrite(input, props) && !targets.has(job)) {
          targets.set(job, { input, token: visible.token });
        }
      }
    }
    if (!targets.size) return;
    // ZCode 先恢复草稿、清空旧会话历史，再在下一帧提交编辑器状态。
    writeFrame = window.requestAnimationFrame(() => {
      writeFrame = window.requestAnimationFrame(() => {
        writeFrame = null;
        for (const [job, { input, token }] of targets) writeResult(job, input, token);
        if (rescan) {
          rescan = false;
          scheduleWrites();
        }
      });
    });
  }

  const observer = new window.MutationObserver(() => {
    scheduleWrites();
    scheduleEnhancementStatus();
  });

  async function enhance(input, owner, text, model, previousReply) {
    const job = { owner };
    if (!jobs.size && !unchanged.size) {
      observer.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ["data-session-id", "data-session-generation", "data-projection-seq", "data-composer-element-screenshots",
          "disabled", "contenteditable", "hidden", "aria-hidden"],
      });
    }
    jobs.add(job);
    for (const completed of unchanged.keys()) {
      if (isOriginalDraft(completed.owner, owner)) expireUnchanged(completed);
    }
    renderEnhancementStatus(input);
    let message = "提示词增强失败，已保留草稿";
    try {
      const result = await request({ ...model, text, ...(previousReply ? { previousReply } : {}) });
      if (!jobs.has(job)) return;
      if (result?.ok && typeof result.text === "string") {
        if (result.text.trim() === text.trim()) {
          unchanged.set(job, window.setTimeout(() => expireUnchanged(job), UNCHANGED_STATUS_MS));
          finish(job);
          return;
        }
        job.text = result.text;
        scheduleWrites();
        return;
      }
      message = result?.error || message;
    } catch { /* 传输异常使用当前草稿范围内的失败提示。 */ }
    if (!jobs.has(job)) return;
    const visibleInput = [...document.querySelectorAll(INPUT)].find((candidate) =>
      candidate.getClientRects().length && isOriginalDraft(owner, readDraftOwner(getComposerProps(candidate))));
    finish(job);
    if (visibleInput) {
      renderEnhancementStatus(visibleInput);
      notify(visibleInput, message);
    }
  }

  function onKey(event) {
    const input = event.target.closest?.(INPUT);
    const space = event.key === " " && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
    if (!event.isTrusted || !input || document.activeElement !== input || !space || event.repeat
      || event.isComposing || event.keyCode === 229 || !caretAtEnd(window, input)) {
      gesture = null;
      return;
    }
    const adapter = getEditor(input);
    if (!adapter || adapter.editor.isComposing()) {
      gesture = null;
      return;
    }
    const props = getComposerProps(input);
    const owner = readDraftOwner(props);
    const draft = adapter.api.getText();
    if (!owner || props.disabled || props.blockingRequestId || props.draftScopeId) {
      gesture = null;
      return;
    }
    const timestamp = event.timeStamp;
    if (!gesture || gesture.input !== input || gesture.token !== owner.token
      || timestamp - gesture.start > GESTURE_MS || draft !== gesture.draft + " ".repeat(gesture.count)) {
      gesture = { input, token: owner.token, start: timestamp, draft, count: 1 };
      return;
    }
    if (gesture.count === 1) {
      gesture.count = 2;
      return;
    }
    const beforeGesture = gesture.draft;
    gesture = null;
    if ([...jobs].some((job) => isOriginalDraft(job.owner, owner))) return;
    if (!beforeGesture.trim()) {
      const suggestion = readyPrediction(owner, props);
      if (!suggestion || containsReferences(input, adapter.api)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setText(window, input, adapter, beforeGesture, "history-merge");
      setText(window, input, adapter, suggestion, "history-push");
      discardPrediction();
      return;
    }
    if (containsReferences(input, adapter.api)) {
      notify(input, "草稿中有引用或附件，暂不能安全增强");
      return;
    }
    if (beforeGesture.length > 20000) {
      notify(input, "草稿超过 20000 个字符，暂不能增强");
      return;
    }
    if (jobs.size >= MAX_ENHANCEMENT_JOBS) {
      notify(input, "增强队列已满。请等待任务结束或切回原会话接收结果，再试一次。");
      return;
    }
    const model = readSelectedModel(props);
    if (!model.providerId || !model.modelId) {
      notify(input, "请先在当前会话选择模型");
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    setText(window, input, adapter, beforeGesture, "history-merge");
    const turn = owner.sessionId && replyContext?.readLatestTurn(props.snapshot, owner.sessionId);
    const previousReply = turn?.providerId === model.providerId && turn.state === "completedSuccess"
      ? replyContext.selectReplyExcerpt(turn.reply, beforeGesture) : "";
    void enhance(input, owner, beforeGesture, model, previousReply);
  }

  const resetGesture = () => {
    gesture = null;
    schedulePredictionPreview();
  };
  const onWriteOpportunity = () => {
    scheduleWrites();
    schedulePredictionPreview();
  };
  document.addEventListener("keydown", onKey, true);
  // 窗口最小化时绘制帧可能停摆，直接监听窗口事件来截断前台观察周期。
  window.addEventListener("blur", endForeground);
  window.addEventListener("focus", updateForeground);
  document.addEventListener("visibilitychange", updateForeground);
  const resetEvents = ["focusout", "pointerdown", "compositionstart"];
  const writeEvents = ["focusin", "compositionend"];
  for (const event of resetEvents) document.addEventListener(event, resetGesture, true);
  for (const event of writeEvents) document.addEventListener(event, onWriteOpportunity, true);
  document.addEventListener("input", schedulePredictionPreview);

  function dispose() {
    disposed = true;
    discardPrediction();
    attemptedPredictions.clear();
    observed = null;
    endForeground();
    jobs.clear();
    for (const timer of unchanged.values()) window.clearTimeout(timer);
    unchanged.clear();
    observer.disconnect();
    if (writeFrame !== null) window.cancelAnimationFrame(writeFrame);
    if (statusFrame !== null) window.cancelAnimationFrame(statusFrame);
    for (const { anchor } of floatingStatuses.values()) anchor.remove();
    floatingStatuses.clear();
    for (const slot of document.querySelectorAll(`.${STATUS_SLOT}`)) slot.remove();
    statusStyle?.remove();
    if (previewFrame !== null) window.cancelAnimationFrame(previewFrame);
    previewStyle?.remove();
    if (noticeTimer !== null) window.clearTimeout(noticeTimer);
    lastNotice?.remove();
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", endForeground);
    window.removeEventListener("focus", updateForeground);
    document.removeEventListener("visibilitychange", updateForeground);
    for (const event of resetEvents) document.removeEventListener(event, resetGesture, true);
    for (const event of writeEvents) document.removeEventListener(event, onWriteOpportunity, true);
    document.removeEventListener("input", schedulePredictionPreview);
  }
  return { observeComposer, dispose };
}

module.exports = { installEnhancement };
