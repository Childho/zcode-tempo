"use strict";

// 输入框识别和富文本保护沿用 ByteRax v1.5.23 的增强接入。许可证见 vendor/。
const INPUT = '[data-testid="v4-composer-input"]';
const COMPOSER = '[data-testid="v4-composer"]';
const GESTURE_MS = 700;

function getEditor(input) {
  const api = input.__zcodeLexicalInputE2E;
  const editor = input.__lexicalEditor;
  if (!api || !editor || editor.getRootElement() !== input) return null;
  return { api, editor };
}

function readDraftOwner(props) {
  if (!props || !props.workspacePath || props.isWebRemoteControl || props.remoteSessionId) return null;
  const workspace = JSON.stringify([props.workspacePath, props.workspaceIdentity || ""]);
  const sessionId = props.sessionId || "";
  return {
    workspace,
    sessionId,
    rootScope: props.rootDraftScopeKey || "",
    token: props.composerDraftScopeToken,
    warmSessionId: props.skillCatalogSessionId || props.attachmentSessionId || "",
  };
}

function isOriginalDraft(origin, visible) {
  if (!visible || origin.workspace !== visible.workspace) return false;
  if (origin.sessionId) return origin.sessionId === visible.sessionId;
  if (visible.sessionId) {
    return origin.warmSessionId === visible.sessionId || origin.token === visible.token;
  }
  return origin.rootScope === visible.rootScope;
}

function readSelectedModel(props) {
  const selection = props.createSubmissionFromComposer?.()?.modelSelection
    || props.draftConfig?.modelSelection || props.composerDraft?.modelSelection;
  return { providerId: selection?.providerId || "", modelId: selection?.modelId || "" };
}

function containsReferences(input, api) {
  const state = api.getEditorState?.();
  return /"type"\s*:\s*"prompt-mention"/.test(JSON.stringify(state) || "")
    || /\]\((?:file|plugin|skill|agent):\/\//.test(api.getText())
    || !!input.closest(COMPOSER)?.querySelector('[data-testid^="v4-attachment-"]');
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

function installEnhancement({ window, document, getComposerProps, request }) {
  let gesture = null;
  let busy = false;
  let pending = null;
  let pendingTimer = null;
  let lastNotice = null;

  function notify(input, message) {
    if (!input.isConnected) return;
    lastNotice?.remove();
    const notice = document.createElement("div");
    notice.setAttribute("role", "status");
    notice.dataset.testid = "harness-enhancement-notice";
    notice.textContent = message;
    notice.style.cssText = "font-size:12px;color:inherit;padding:3px 8px;opacity:.85";
    input.closest(COMPOSER)?.append(notice);
    lastNotice = notice;
    window.setTimeout(() => notice.remove(), 4500);
  }

  function scheduleWrite() {
    if (pendingTimer !== null || !pending) return;
    pendingTimer = window.setTimeout(() => {
      pendingTimer = null;
      writeWhenVisible();
    }, 150);
  }

  function writeWhenVisible() {
    if (!pending) return;
    const result = pending;
    const input = Array.from(document.querySelectorAll(INPUT)).find((element) => {
      const props = getComposerProps(element);
      return element.getClientRects().length && !props?.disabled
        && !props?.blockingRequestId && !props?.draftScopeId
        && isOriginalDraft(result.owner, readDraftOwner(props));
    });
    if (!input) return scheduleWrite();
    const mountedToken = getComposerProps(input)?.composerDraftScopeToken;
    // ZCode 先恢复草稿、清空旧会话历史，再在下一帧提交编辑器状态。
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const props = getComposerProps(input);
      const adapter = input.isConnected && getEditor(input);
      if (!adapter || !input.getClientRects().length || props?.disabled || props?.blockingRequestId || props?.draftScopeId
        || props?.composerDraftScopeToken !== mountedToken
        || !isOriginalDraft(result.owner, readDraftOwner(props))) return scheduleWrite();
      if (adapter.editor.isComposing() || containsReferences(input, adapter.api)) {
        if (!result.noticeShown && !adapter.editor.isComposing()) {
          notify(input, "草稿中有引用或附件，移除后将回填增强结果");
          result.noticeShown = true;
        }
        return scheduleWrite();
      }
      try {
        // 强制创建一条原生撤销记录，覆盖前的现有文本就是撤销目标。
        if (adapter.api.getText() !== result.text) {
          setText(window, input, adapter, result.text, "history-push");
        }
      } catch {
        notify(input, "增强结果写回失败，已保留草稿");
      }
      pending = null;
    }));
  }

  async function enhance(input, props, owner, text) {
    const { providerId, modelId } = readSelectedModel(props);
    if (!providerId || !modelId) {
      notify(input, "请先在当前会话选择模型");
      return;
    }
    busy = true;
    try {
      const result = await request({ providerId, modelId, text });
      if (result.ok) {
        pending = { owner, text: result.text, noticeShown: false };
        writeWhenVisible();
      } else {
        notify(input, result.error || "提示词增强失败，已保留草稿");
      }
    } catch {
      notify(input, "提示词增强失败，已保留草稿");
    } finally {
      busy = false;
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
    if (!owner || props.disabled || props.blockingRequestId || props.draftScopeId || !draft.trim()) {
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
    if (containsReferences(input, adapter.api)) {
      notify(input, "草稿中有引用或附件，暂不能安全增强");
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    setText(window, input, adapter, beforeGesture, "history-merge");
    if (busy || pending) return;
    if (beforeGesture.length > 20000) {
      notify(input, "草稿超过 20000 个字符，暂不能增强");
      return;
    }
    void enhance(input, props, owner, beforeGesture);
  }

  const resetGesture = () => { gesture = null; };
  document.addEventListener("keydown", onKey, true);
  for (const event of ["focusout", "pointerdown", "compositionstart"]) {
    document.addEventListener(event, resetGesture, true);
  }
}

module.exports = { installEnhancement };
