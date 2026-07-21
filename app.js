// ---------- Elements ----------
const editor = document.getElementById('editor');
const decoyEditor = document.getElementById('decoyEditor');
const docTitle = document.getElementById('docTitle');
const statusEl = document.getElementById('status');
const dotsBtn = document.getElementById('dotsBtn');
const settingsOverlay = document.getElementById('settingsOverlay');
const providerSelect = document.getElementById('providerSelect');
const apiKeyInput = document.getElementById('apiKeyInput');
const modelNameInput = document.getElementById('modelNameInput');
const decoyTextInput = document.getElementById('decoyTextInput');
const autoArmToggle = document.getElementById('autoArmToggle');
const openShortcutsLink = document.getElementById('openShortcutsLink');
const saveSettingsBtn = document.getElementById('saveSettings');
const closeSettingsBtn = document.getElementById('closeSettings');

const DEFAULT_DECOY_TEXT =
  '第三季度总结\n\n本季度整体进展符合预期，团队在核心指标上保持稳步提升。' +
  '以下为主要工作回顾与后续计划要点，具体数据将在下次同步会议中详细说明。\n\n' +
  '（草稿，待补充）';

const DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o'
};

// ---------- Settings: load / save ----------
async function loadSettings() {
  const data = await chrome.storage.local.get([
    'provider', 'apiKey', 'modelName', 'docContent', 'docTitle',
    'decoyText', 'autoArmOnBlur', 'panicActive'
  ]);
  providerSelect.value = data.provider || 'anthropic';
  apiKeyInput.value = data.apiKey || '';
  modelNameInput.value = data.modelName || DEFAULT_MODELS[providerSelect.value];
  if (data.docTitle) docTitle.textContent = data.docTitle;
  if (data.docContent) {
    editor.innerHTML = data.docContent;
  } else {
    editor.textContent = '> ';
  }

  decoyTextInput.value = data.decoyText || '';
  autoArmToggle.checked = !!data.autoArmOnBlur;
  decoyEditor.textContent = data.decoyText || DEFAULT_DECOY_TEXT;

  renderPanicState(!!data.panicActive);
}

async function saveSettings() {
  await chrome.storage.local.set({
    provider: providerSelect.value,
    apiKey: apiKeyInput.value.trim(),
    modelName: modelNameInput.value.trim() || DEFAULT_MODELS[providerSelect.value],
    decoyText: decoyTextInput.value,
    autoArmOnBlur: autoArmToggle.checked
  });
  decoyEditor.textContent = decoyTextInput.value || DEFAULT_DECOY_TEXT;
  settingsOverlay.classList.remove('open');
  flashStatus('已保存');
}

openShortcutsLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

providerSelect.addEventListener('change', () => {
  if (!modelNameInput.value || Object.values(DEFAULT_MODELS).includes(modelNameInput.value)) {
    modelNameInput.value = DEFAULT_MODELS[providerSelect.value];
  }
});

dotsBtn.addEventListener('click', () => settingsOverlay.classList.add('open'));
closeSettingsBtn.addEventListener('click', () => settingsOverlay.classList.remove('open'));
settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) settingsOverlay.classList.remove('open');
});
saveSettingsBtn.addEventListener('click', saveSettings);

// ---------- Persist doc content (debounced) ----------
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.local.set({
      docContent: editor.innerHTML,
      docTitle: docTitle.textContent
    });
  }, 500);
}
editor.addEventListener('input', scheduleSave);
docTitle.addEventListener('input', scheduleSave);

function flashStatus(msg, persist = false) {
  statusEl.textContent = msg;
  if (!persist) {
    setTimeout(() => { if (statusEl.textContent === msg) statusEl.textContent = ''; }, 1800);
  }
}

// ---------- Prompt detection + generation ----------
// Caret position is tracked as a single integer — the character offset
// into editor.textContent — rather than a specific (node, localOffset)
// pair. Tracking a specific node breaks because the browser doesn't
// always anchor selection inside a Text node: after our own
// insertTextAtCaret() calls (and in a few other cases), the selection
// anchor can legitimately BE the container <div> itself, with the
// "offset" meaning "child index" rather than "character index". Mixing
// those two meanings is exactly what caused the crash. Working in plain
// global character offsets and only touching real DOM nodes at the
// point we actually set/read the Selection sidesteps that entirely.

function getGlobalCaretOffset() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  if (!editor.contains(sel.anchorNode)) return null;
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.setEnd(sel.anchorNode, sel.anchorOffset);
  return range.toString().length;
}

function setGlobalCaretOffset(targetOffset) {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let node;
  let accumulated = 0;
  while ((node = walker.nextNode())) {
    const len = node.textContent.length;
    if (accumulated + len >= targetOffset) {
      const range = document.createRange();
      range.setStart(node, targetOffset - accumulated);
      range.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
    accumulated += len;
  }
  // Fell off the end (e.g. targetOffset === editor.textContent.length
  // exactly, or editor has no text nodes at all) — just go to the end.
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function insertTextAtGlobalOffset(targetOffset, text) {
  setGlobalCaretOffset(targetOffset);
  const sel = window.getSelection();
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const textNode = document.createTextNode(text);
  range.insertNode(textNode);
  range.setStartAfter(textNode);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

// A "prompt line" is any line in the current block starting with ">"
function getCurrentLineInfo() {
  const caretOffset = getGlobalCaretOffset();
  if (caretOffset === null) return null;
  const text = editor.textContent || '';
  const beforeCaret = text.slice(0, caretOffset);
  const lineStart = beforeCaret.lastIndexOf('\n') + 1;
  const afterCaret = text.slice(caretOffset);
  const lineEndRel = afterCaret.indexOf('\n');
  const lineEnd = lineEndRel === -1 ? text.length : caretOffset + lineEndRel;
  return { lineStart, lineEnd, full: text.slice(lineStart, lineEnd) };
}

editor.addEventListener('keydown', async (e) => {
  const isGenerateShortcut = (e.metaKey || e.ctrlKey) && e.key === 'Enter';
  if (!isGenerateShortcut) return;

  e.preventDefault();

  const line = getCurrentLineInfo();
  if (!line) return;
  const trimmed = line.full.trim();

  if (!trimmed.startsWith('>')) {
    flashStatus('在以 > 开头的行触发生成');
    return;
  }

  const prompt = trimmed.replace(/^>\s*/, '');
  if (!prompt) return;

  await runGeneration(prompt, line);
});

async function runGeneration(prompt, line) {
  const settings = await chrome.storage.local.get(['provider', 'apiKey', 'modelName']);
  if (!settings.apiKey) {
    flashStatus('请先在设置中填写 API Key');
    settingsOverlay.classList.add('open');
    return;
  }

  flashStatus('生成中…', true);

  // Keep the "> ..." prompt line as-is; insert the result after it.
  const insertOffset = line.lineEnd;

  try {
    const result = await callAI(settings.provider, settings.apiKey, settings.modelName, prompt);
    insertTextAtGlobalOffset(insertOffset, '\n' + result + '\n\n> ');
    flashStatus('');
  } catch (err) {
    insertTextAtGlobalOffset(insertOffset, `\n[生成失败：${err.message}]\n\n> `);
    flashStatus('生成失败', true);
    setTimeout(() => flashStatus(''), 2500);
  }
  scheduleSave();
}

// ---------- AI provider calls ----------
async function callAI(provider, apiKey, model, prompt) {
  if (provider === 'openai') {
    return callOpenAI(apiKey, model, prompt);
  }
  return callAnthropic(apiKey, model, prompt);
}

async function callAnthropic(apiKey, model, prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: model || DEFAULT_MODELS.anthropic,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`${res.status} ${errBody.slice(0, 120)}`);
  }
  const data = await res.json();
  const textBlock = (data.content || []).find(b => b.type === 'text');
  return textBlock ? textBlock.text.trim() : '';
}

async function callOpenAI(apiKey, model, prompt) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model || DEFAULT_MODELS.openai,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`${res.status} ${errBody.slice(0, 120)}`);
  }
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}

// ---------- Panic mode ----------
async function renderPanicState(active) {
  if (active) {
    const { decoyText } = await chrome.storage.local.get('decoyText');
    decoyEditor.textContent = decoyText || DEFAULT_DECOY_TEXT;
    editor.classList.remove('active');
    decoyEditor.classList.add('active');
    settingsOverlay.classList.remove('open');
    // pointer-events:none doesn't strip keyboard focus, so move it
    // explicitly or a keystroke could silently land in the hidden real doc.
    if (document.activeElement === editor) editor.blur();
    decoyEditor.focus();
  } else {
    editor.classList.add('active');
    decoyEditor.classList.remove('active');
    if (document.activeElement === decoyEditor) decoyEditor.blur();
    editor.focus();
  }
}

// React to the global shortcut, which flips this flag from background.js.
// storage.onChanged fires in every open extension page, so any new-tab
// instance updates immediately regardless of which one is focused.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if ('panicActive' in changes) {
    renderPanicState(!!changes.panicActive.newValue);
  }
  if ('decoyText' in changes) {
    decoyEditor.textContent = changes.decoyText.newValue || DEFAULT_DECOY_TEXT;
  }
});

// Also allow a plain in-page shortcut as a fallback, since chrome.commands
// shortcuts can silently fail to register if they collide with another
// extension or OS-level binding.
document.addEventListener('keydown', async (e) => {
  const isPanicShortcut = (e.metaKey || e.ctrlKey) && e.shiftKey && e.code === 'Space';
  if (!isPanicShortcut) return;
  e.preventDefault();
  const { panicActive } = await chrome.storage.local.get('panicActive');
  await chrome.storage.local.set({ panicActive: !panicActive });
});

// Optional: auto-arm when this tab loses focus (tab switch, alt-tab, etc).
// Off by default because it also fires on ordinary tab switching, not just
// screen-share — see settings toggle.
let blurArmTimer = null;
window.addEventListener('blur', async () => {
  const { autoArmOnBlur, panicActive } = await chrome.storage.local.get(['autoArmOnBlur', 'panicActive']);
  if (!autoArmOnBlur || panicActive) return;
  // Small delay so a brief focus flicker (e.g. opening the shortcuts page
  // we just linked to) doesn't immediately trip it.
  blurArmTimer = setTimeout(() => {
    chrome.storage.local.set({ panicActive: true });
  }, 1500);
});
window.addEventListener('focus', () => {
  clearTimeout(blurArmTimer);
});

// ---------- Init ----------
loadSettings().then(() => {
  editor.focus();
  // Place caret at the end so a fresh "> " document is ready to type into.
  setGlobalCaretOffset(editor.textContent.length);
});
