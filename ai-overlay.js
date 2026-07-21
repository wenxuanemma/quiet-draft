// ============================================================
// SITE CONFIG — one entry per supported AI chat site. Each site
// needs its own 4 touchpoints found via DevTools (right-click →
// Inspect on the real page):
//   input        — the message textbox at the bottom of a chat.
//   sendButton   — the send/submit button next to the input.
//   stopButton   — the "stop generating" button that's ONLY
//                  present while the AI is actively responding.
//                  Its disappearance is how we know a reply finished.
//   lastMessage  — a selector matching assistant message
//                  containers, so we can grab the most recent one's
//                  text after generation completes.
//
// To add a new site: add an entry here keyed by location.hostname,
// then add a matching block to manifest.json's content_scripts
// "matches" array (and host_permissions, for consistency).
// ============================================================
const SITE_CONFIGS = {
  'claude.ai': {
    input: '[data-testid="chat-input"]',
    sendButton: 'button[aria-label="Send message"]',
    stopButton: 'button[aria-label="Stop response"]',
    lastMessage: '.standard-markdown'
  },
  'chatgpt.com': {
    input: '#prompt-textarea',
    sendButton: '[data-testid="send-button"]',
    stopButton: '[data-testid="stop-button"]',
    lastMessage: '[data-message-author-role="assistant"] .markdown'
  },
  'gemini.google.com': {
    input: '[aria-label="Enter a prompt for Gemini"]',
    sendButton: 'button[aria-label="Send message"]',
    stopButton: 'button[aria-label="Stop response"]',
    lastMessage: 'message-content .markdown'
  }
};

const SELECTORS = SITE_CONFIGS[location.hostname] || null;
const SITE_CONFIGURED = !!(SELECTORS && SELECTORS.input && SELECTORS.sendButton && SELECTORS.lastMessage);

const GENERATION_TIMEOUT_MS = 60000;
const GENERATION_POLL_MS = 400;

// ============================================================
// Overlay UI — built inside a Shadow DOM so the host page's own CSS
// can't bleed in and our styles can't bleed out.
// ============================================================
let overlayHost = null;
let shadowRoot = null;
let editorEl = null;
let statusEl = null;
let overlayActive = false;

function buildOverlay() {
  if (overlayHost) return;

  overlayHost = document.createElement('div');
  overlayHost.id = 'qd-overlay-host';
  overlayHost.style.cssText = `
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    display: none;
  `;
  document.documentElement.appendChild(overlayHost);

  shadowRoot = overlayHost.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .qd-root {
      position: fixed;
      inset: 0;
      background: #F1EFEA;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
      color: #2B2926;
    }
    .qd-menubar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 24px;
      background: #FDFCFA;
      border-bottom: 1px solid #E8E5DF;
      font-size: 14px;
    }
    .qd-status { font-size: 12px; color: #8A8578; }
    .qd-page-wrap {
      display: flex;
      justify-content: center;
      padding: 40px 20px 120px;
      height: calc(100% - 52px);
      overflow-y: auto;
    }
    .qd-page {
      width: 100%;
      max-width: 720px;
      min-height: 800px;
      background: #FDFCFA;
      box-shadow: 0 1px 3px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.05);
      padding: 96px 88px;
      border-radius: 2px;
    }
    .qd-editor {
      font-family: Georgia, "Noto Serif SC", "Songti SC", "SimSun", serif;
      font-size: 16px;
      line-height: 1.9;
      outline: none;
      min-height: 600px;
      white-space: pre-wrap;
      word-wrap: break-word;
    }
    .qd-editor:empty::before {
      content: "开始输入…\A\A提示：单独一行以 > 开头并按 Ctrl/Cmd + Enter，即可生成内容。";
      white-space: pre-wrap;
      color: #B8B3A8;
    }
  `;
  shadowRoot.appendChild(style);

  const root = document.createElement('div');
  root.className = 'qd-root';
  root.innerHTML = `
    <div class="qd-menubar">
      <span>无标题文档</span>
      <span class="qd-status" id="qd-status"></span>
    </div>
    <div class="qd-page-wrap">
      <div class="qd-page">
        <div class="qd-editor" contenteditable="true" spellcheck="false" id="qd-editor"></div>
      </div>
    </div>
  `;
  shadowRoot.appendChild(root);

  editorEl = shadowRoot.getElementById('qd-editor');
  statusEl = shadowRoot.getElementById('qd-status');
  editorEl.textContent = '> ';
}

function setOverlayActive(active) {
  const justBuilt = !overlayHost;
  overlayActive = active;
  if (justBuilt) buildOverlay();
  overlayHost.style.display = active ? 'block' : 'none';
  if (active) {
    editorEl.focus();
    if (justBuilt) {
      setGlobalCaretOffset(editorEl.textContent.length);
    }
    if (!SITE_CONFIGURED) {
      flashStatus(`${location.hostname} 尚未适配，生成功能暂不可用`, true);
    }
  }
}

// ============================================================
// Relay logic — talk to the real page underneath
// ============================================================
function flashStatus(msg, persist = false) {
  if (!statusEl) return;
  statusEl.textContent = msg;
  if (!persist) {
    setTimeout(() => { if (statusEl.textContent === msg) statusEl.textContent = ''; }, 2000);
  }
}

function findInput() {
  return document.querySelector(SELECTORS.input);
}
function findSendButton() {
  return document.querySelector(SELECTORS.sendButton);
}
function isGenerating() {
  return !!document.querySelector(SELECTORS.stopButton);
}
function getLastMessageText() {
  const nodes = document.querySelectorAll(SELECTORS.lastMessage);
  if (!nodes.length) return null;
  return nodes[nodes.length - 1].innerText.trim();
}

// React (and most modern frameworks) track input state internally and
// ignore plain `.value = x` assignment on controlled inputs. Using the
// native setter + dispatching a real input event is the standard
// workaround so the framework's own state actually updates.
function setNativeInputValue(el, text) {
  if (el.isContentEditable) {
    el.focus();
    document.execCommand('insertText', false, text);
    return;
  }
  const proto = Object.getPrototypeOf(el);
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) {
    setter.call(el, text);
  } else {
    el.value = text;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function waitForGenerationToStart(timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isGenerating()) return true;
    await sleep(GENERATION_POLL_MS);
  }
  return false;
}

async function waitForGenerationToFinish() {
  const start = Date.now();
  while (Date.now() - start < GENERATION_TIMEOUT_MS) {
    if (!isGenerating()) return true;
    await sleep(GENERATION_POLL_MS);
  }
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function relayPromptToSite(prompt) {
  if (!SITE_CONFIGURED) {
    throw new Error(`${location.hostname} 尚未配置选择器，需要先用 DevTools 找 4 个锚点`);
  }

  const input = findInput();
  if (!input) {
    throw new Error('找不到输入框，请检查 SITE_CONFIGS 里对应站点的 input 配置');
  }

  setNativeInputValue(input, prompt);
  await sleep(150); // let the framework's state settle before we submit

  const sendBtn = findSendButton();
  if (sendBtn) {
    sendBtn.click();
  } else {
    // Fallback: many chat UIs submit on Enter.
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }

  const started = await waitForGenerationToStart();
  if (!started) {
    // Some responses are fast enough that we miss the "generating" window
    // entirely — not necessarily an error, so we just proceed to read
    // whatever is currently the last message rather than throwing.
  } else {
    await waitForGenerationToFinish();
  }

  await sleep(300); // let final DOM settle after streaming stops
  const text = getLastMessageText();
  if (!text) {
    throw new Error('生成完成，但未能读取回复内容，请检查 SELECTORS.lastMessage 配置');
  }
  return text;
}

// ============================================================
// Editor interaction — same ">" + Ctrl/Cmd+Enter convention as
// the standalone new-tab version.
//
// Caret position is tracked as a single integer — the character
// offset into editorEl.textContent — rather than a specific (node,
// localOffset) pair. Tracking a specific node breaks because the
// browser doesn't always anchor selection inside a Text node: after
// our own insertTextAtCaret() calls, the selection anchor can
// legitimately BE the container element itself, with "offset" meaning
// "child index" rather than "character index". Mixing those two
// meanings causes a Range IndexSizeError. Working in plain global
// character offsets and only touching real DOM nodes at the point we
// actually set/read the Selection sidesteps that entirely.
//
// Separately: Chrome doesn't reliably report the correct anchorNode
// from window.getSelection() when the caret is inside an open shadow
// root — ShadowRoot.getSelection() (a Chromium-specific API) is the
// one that actually works here. Every Selection read/write below goes
// through getActiveSelection() rather than window.getSelection()
// directly, or this silently breaks again.
// ============================================================
function getActiveSelection() {
  return shadowRoot.getSelection ? shadowRoot.getSelection() : window.getSelection();
}

function getGlobalCaretOffset() {
  const sel = getActiveSelection();
  if (!sel || !sel.rangeCount) return null;
  if (!editorEl.contains(sel.anchorNode)) return null;
  const range = document.createRange();
  range.selectNodeContents(editorEl);
  range.setEnd(sel.anchorNode, sel.anchorOffset);
  return range.toString().length;
}

function setGlobalCaretOffset(targetOffset) {
  const walker = document.createTreeWalker(editorEl, NodeFilter.SHOW_TEXT);
  let node;
  let accumulated = 0;
  while ((node = walker.nextNode())) {
    const len = node.textContent.length;
    if (accumulated + len >= targetOffset) {
      const range = document.createRange();
      range.setStart(node, targetOffset - accumulated);
      range.collapse(true);
      const sel = getActiveSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
    accumulated += len;
  }
  const range = document.createRange();
  range.selectNodeContents(editorEl);
  range.collapse(false);
  const sel = getActiveSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function insertTextAtGlobalOffset(targetOffset, text) {
  setGlobalCaretOffset(targetOffset);
  const sel = getActiveSelection();
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const textNode = document.createTextNode(text);
  range.insertNode(textNode);
  range.setStartAfter(textNode);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function getCurrentLineInfo() {
  const caretOffset = getGlobalCaretOffset();
  if (caretOffset === null) return null;
  const text = editorEl.textContent || '';
  const beforeCaret = text.slice(0, caretOffset);
  const lineStart = beforeCaret.lastIndexOf('\n') + 1;
  const afterCaret = text.slice(caretOffset);
  const lineEndRel = afterCaret.indexOf('\n');
  const lineEnd = lineEndRel === -1 ? text.length : caretOffset + lineEndRel;
  return { lineStart, lineEnd, full: text.slice(lineStart, lineEnd) };
}

async function handleEditorKeydown(e) {
  const line = getCurrentLineInfo();
  if (!line) return;
  const trimmed = line.full.trim();
  if (!trimmed.startsWith('>')) {
    flashStatus('在以 > 开头的行触发生成');
    return;
  }

  const prompt = trimmed.replace(/^>\s*/, '');
  if (!prompt) return;

  const insertOffset = line.lineEnd; // keep the "> ..." line as-is; insert after it

  flashStatus('生成中…', true);
  try {
    const result = await relayPromptToSite(prompt);
    // Focusing the real page's input during the relay moved the
    // browser's one global selection/caret there. Reclaim focus before
    // inserting, or the result silently lands in the real input instead
    // of our overlay.
    editorEl.focus();
    insertTextAtGlobalOffset(insertOffset, '\n' + result + '\n\n> ');
    flashStatus('');
  } catch (err) {
    editorEl.focus();
    insertTextAtGlobalOffset(insertOffset, `\n[生成失败：${err.message}]\n\n> `);
    flashStatus('生成失败', true);
    setTimeout(() => flashStatus(''), 2500);
  }
}

// ============================================================
// Global key interceptor — the host page's own script very likely
// has a document/window-level keydown listener that hijacks keystrokes
// to refocus its native chat input (a common "start typing anywhere"
// UX pattern). Since our overlay lives in the same top-level page,
// those keystrokes reach the page's listener before they'd reach an
// element-level listener of ours. We intercept at the window level,
// in the capture phase, which always runs before any listener attached
// to a descendant node (document, body, etc) — regardless of
// registration order, because capture strictly follows tree depth.
// We stop propagation so the page's script never sees the event, but
// we deliberately do NOT call preventDefault for ordinary keys, so the
// browser's native contenteditable typing behavior still applies.
function isOverlayKeyEvent(e) {
  if (!overlayActive || !editorEl) return false;
  const path = e.composedPath();
  return path.includes(editorEl);
}

window.addEventListener('keydown', (e) => {
  if (!isOverlayKeyEvent(e)) return;
  e.stopImmediatePropagation();

  const isGenerateShortcut = (e.metaKey || e.ctrlKey) && e.key === 'Enter';
  if (isGenerateShortcut) {
    e.preventDefault();
    handleEditorKeydown(e);
  }
  // Any other key: propagation is stopped (page can't hijack it), but
  // we don't preventDefault, so native contenteditable typing proceeds.
}, true);

// Some pages hook 'beforeinput' or 'input' instead of/in addition to
// keydown for their global shortcuts — same shielding, no interference
// with native text insertion since we never call preventDefault here.
['keypress', 'keyup', 'beforeinput', 'input'].forEach((eventName) => {
  window.addEventListener(eventName, (e) => {
    if (!isOverlayKeyEvent(e)) return;
    e.stopImmediatePropagation();
  }, true);
});

// ============================================================
// Wiring
// ============================================================
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'QD_TOGGLE_OVERLAY') {
    setOverlayActive(!overlayActive);
  }
});
