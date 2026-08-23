import { getLang, setLang, tSync } from './i18n';

const $ = (id: string) => document.getElementById(id)!;

const statusDot = $('statusDot');
const btnStart = $('btnStart') as HTMLButtonElement;
const btnStop = $('btnStop') as HTMLButtonElement;
const chkOverlay = $('chkOverlay') as HTMLInputElement;
const chkPunct = $('chkPunct') as HTMLInputElement;
const chkShowPrev = $('chkShowPrev') as HTMLInputElement;
const prevOpacitySlider = $('prevOpacitySlider') as HTMLInputElement;
const prevOpacityLabel = $('prevOpacityLabel');
const endpointRule1 = $('endpointRule1') as HTMLInputElement;
const endpointRule2 = $('endpointRule2') as HTMLInputElement;
const endpointRule3 = $('endpointRule3') as HTMLInputElement;
const endpointVal1 = $('endpointVal1');
const endpointVal2 = $('endpointVal2');
const endpointVal3 = $('endpointVal3');
const textPreview = $('textPreview');
const modelStatus = $('modelStatus');
const btnLock = $('btnLock') as HTMLButtonElement;
const lockLabel = $('lockLabel');
const fontSizeSlider = $('fontSizeSlider') as HTMLInputElement;
const fontSizeLabel = $('fontSizeLabel');
const btnLang = $('btnLang') as HTMLButtonElement;
const btnResetOverlay = $('btnResetOverlay') as HTMLButtonElement;
const btnCopy = $('btnCopy') as HTMLButtonElement;
const btnClear = $('btnClear') as HTMLButtonElement;
const transcriptBox = $('transcriptBox');

let locked = false;
let lastStatus = 'Stopped';
let currentLang = 'zh_CN';
let transcriptEntries: string[] = [];
const PREFS_KEY = 'tmspeech_prefs';
const TRANSCRIPT_KEY = 'tmspeech_transcript';

requestAnimationFrame(() => {
  document.querySelector('.container')?.classList.add('loaded');
});

async function applyLang() {
  currentLang = await getLang();
  const tr = (key: string) => tSync(currentLang, key);
  $('appTitle').textContent = tr('appTitle');
  $('btnStartText').textContent = tr('btnStart');
  $('btnStopText').textContent = tr('btnStop');
  $('audioSource').textContent = tr('audioSource');
  $('sourceDesc').textContent = tr('sourceDesc');
  $('showSubtitles').textContent = tr('showSubtitles');
  $('fontLabel').textContent = tr('font');
  $('modelInfo').textContent = tr('modelInfo');
  const rt = document.getElementById('readyText');
  if (rt) rt.textContent = tr('ready');
  $('transcriptLabel').textContent = tr('transcript');
  $('copyLabel').textContent = tr('copy');
  $('clearLabel').textContent = tr('clearTranscript');
  $('disclaimer').textContent = tr('disclaimer');
  $('resetOverlayLabel').textContent = tr('resetPosition');
  $('showPunct').textContent = tr('showPunct');
  // 坑：punctNote 小字注释已升级为 ? 帮助气泡，原元素与赋值一并移除；
  // 帮助文案必须在 applyLang 内刷新，否则语言切换后气泡仍显示旧语言
  $('helpTipPunct').textContent = tr('helpPunct');
  $('helpTipPrev').textContent = tr('helpPrev');
  $('helpTipEndpoint1').textContent = tr('helpEndpoint1');
  $('helpTipEndpoint2').textContent = tr('helpEndpoint2');
  $('helpTipEndpoint3').textContent = tr('helpEndpoint3');
  document.querySelectorAll<HTMLElement>('.help-btn').forEach(b => b.setAttribute('aria-label', tr('helpHint')));
  $('showPrev').textContent = tr('showPrev');
  $('prevOpacity').textContent = tr('prevOpacity');
  $('endpointLabel1').textContent = tr('endpointRule1');
  $('endpointLabel2').textContent = tr('endpointRule2');
  $('endpointLabel3').textContent = tr('endpointRule3');
  $('secDisplay').textContent = tr('secDisplay');
  $('secPrev').textContent = tr('secPrev');
  $('secPunct').textContent = tr('secPunct');
  $('resetEndpointLabel').textContent = tr('resetEndpoint');
  btnLang.textContent = tr('langSwitch');
  updateLockUI();
  renderTranscript();
}

async function loadPrefs() {
  const r = await chrome.storage.local.get(PREFS_KEY);
  const prefs: Record<string, any> = r[PREFS_KEY] || {};
  if (prefs.fontSize) {
    fontSizeSlider.value = String(prefs.fontSize);
    fontSizeLabel.textContent = String(prefs.fontSize);
  }
  chkShowPrev.checked = prefs.showPrev !== false;
  // 坑：字幕开关必须从 prefs 恢复——此前勾选态永远回到 HTML 默认 checked，
  // 与上次会话的真实可见性脱节（START 时才把当次值带上，用户上次的选择丢失）。
  // 键名 overlayVisible 与 START 消息的 msg.overlayVisible 对齐；默认开（!== false）。
  chkOverlay.checked = prefs.overlayVisible !== false;
  const po = prefs.prevOpacity ?? 35;
  prevOpacitySlider.value = String(po);
  prevOpacityLabel.textContent = String(po);
  const r1 = prefs.endpointRule1 ?? 0.8;
  const r2 = prefs.endpointRule2 ?? 0.6;
  const r3 = prefs.endpointRule3 ?? 15;
  endpointRule1.value = String(Math.round(r1 * 10));
  endpointVal1.textContent = r1.toFixed(1) + 's';
  endpointRule2.value = String(Math.round(r2 * 10));
  endpointVal2.textContent = r2.toFixed(1) + 's';
  endpointRule3.value = String(r3);
  endpointVal3.textContent = r3 + 's';
}

function savePrefs(partial: Record<string, any>) {
  chrome.storage.local.get(PREFS_KEY).then(r => {
    const merged = { ...((r[PREFS_KEY] as any) || {}), ...partial };
    chrome.storage.local.set({ [PREFS_KEY]: merged });
  });
}

function setStatus(status: string) {
  statusDot.className = 'status-dot ' + status;
  btnStart.disabled = status === 'Running';
  btnStop.disabled = status === 'Stopped';
  // 记录当前会话态，供 chkOverlay 切换时判断"是否处于运行中"以给出对应反馈
  lastStatus = status;
}

function log(msg: string) {
  modelStatus.textContent = msg;
}

function updateLockUI() {
  const tr = (key: string) => tSync(currentLang, key);
  const isLocked = locked;
  lockLabel.textContent = isLocked ? tr('unlock') : tr('lock');
  btnLock.innerHTML = isLocked
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8.5 11V7a3.5 3.5 0 0 1 6.5-2"/></svg><span id="lockLabel">' + tr('unlock') + '</span>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 1 1 8 0v4"/></svg><span id="lockLabel">' + tr('lock') + '</span>';
}

btnStart.onclick = async () => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs[0]?.id;
  if (!tabId) { log('没有找到活跃标签页'); return; }

  chrome.runtime.sendMessage({
    type: 'START_RECOGNITION',
    tabId,
    overlayVisible: chkOverlay.checked,
  }).catch(() => {});
  setStatus('Running');
};

btnStop.onclick = () => {
  chrome.runtime.sendMessage({ type: 'STOP_RECOGNITION' }).catch(() => {});
  setStatus('Stopped');
};

chkOverlay.onchange = () => {
  const visible = chkOverlay.checked;
  // 坑：无论会话是否运行都要持久化——此前只在 bg 有 captureTabId 时才转发生效，
  // 未启动会话时切换是静默无效的，且重开 popup 后勾选态丢失。
  // 写入 tmspeech_prefs.overlayVisible 后，下次 START 时随 msg.overlayVisible 生效。
  savePrefs({ overlayVisible: visible });
  chrome.runtime.sendMessage({ type: 'OVERLAY_TOGGLE', visible }).catch(() => {});
  // 可见反馈：运行中切换由 OVERLAY_TOGGLE 链路即时生效，无需提示；
  // 未启动会话时明确告知"已保存、下次开始识别时生效"，不再静默。
  // 注：反馈文案暂内联双语（改动范围不含 i18n.ts，待后续补词条）。
  if (lastStatus !== 'Running') {
    log(currentLang === 'zh_CN'
      ? '当前无进行中的识别，设置已保存，下次开始时生效'
      : 'No active session — saved, applies on next start');
  }
};

chkPunct.onchange = () => {
  const val = chkPunct.checked;
  chrome.storage.local.set({ tmspeech_use_punct: val });
  chrome.runtime.sendMessage({ type: 'SET_PUNCT', enabled: val }).catch(() => {});
};

btnResetOverlay.onclick = () => {
  chrome.runtime.sendMessage({ type: 'RESET_OVERLAY_POSITION' }).catch(() => {});
};

btnLock.onclick = () => {
  locked = !locked;
  chrome.runtime.sendMessage({ type: 'LOCK_TOGGLE', locked }).catch(() => {});
  updateLockUI();
};

btnLang.onclick = async () => {
  const newLang = currentLang === 'zh_CN' ? 'en' : 'zh_CN';
  await setLang(newLang);
  await applyLang();
};

async function loadTranscript() {
  const r = await chrome.storage.local.get(TRANSCRIPT_KEY);
  transcriptEntries = (r[TRANSCRIPT_KEY] as string[]) || [];
  renderTranscript();
}

function saveTranscript() {
  chrome.storage.local.set({ [TRANSCRIPT_KEY]: transcriptEntries });
}

function renderTranscript() {
  if (transcriptEntries.length === 0) {
    transcriptBox.innerHTML = `<div class="transcript-empty" id="transcriptEmpty">${tSync(currentLang, 'transcriptEmpty')}</div>`;
    return;
  }
  transcriptBox.innerHTML = transcriptEntries.map(t =>
    `<div class="transcript-entry">${escapeHtml(t)}</div>`
  ).join('');
  transcriptBox.scrollTop = transcriptBox.scrollHeight;
}

btnCopy.onclick = async () => {
  const text = transcriptEntries.join('\n');
  if (!text) return;
  await navigator.clipboard.writeText(text);
  const label = $('copyLabel');
  const orig = label.textContent!;
  label.textContent = tSync(currentLang, 'copied');
  setTimeout(() => { label.textContent = orig; }, 1200);
};

btnClear.onclick = () => {
  transcriptEntries = [];
  chrome.storage.local.remove(TRANSCRIPT_KEY);
  renderTranscript();
};

function sendEndpoint() {
  const r1 = parseInt(endpointRule1.value) / 10;
  const r2 = parseInt(endpointRule2.value) / 10;
  const r3 = parseInt(endpointRule3.value);
  savePrefs({ endpointRule1: r1, endpointRule2: r2, endpointRule3: r3 });
  chrome.runtime.sendMessage({ type: 'SET_ENDPOINT', rule1: r1, rule2: r2, rule3: r3 }).catch(() => {});
}

endpointRule1.oninput = () => { endpointVal1.textContent = (parseInt(endpointRule1.value) / 10).toFixed(1) + 's'; sendEndpoint(); };
endpointRule2.oninput = () => { endpointVal2.textContent = (parseInt(endpointRule2.value) / 10).toFixed(1) + 's'; sendEndpoint(); };
endpointRule3.oninput = () => { endpointVal3.textContent = endpointRule3.value + 's'; sendEndpoint(); };

const ENDPOINT_DEFAULTS = { endpointRule1: 0.8, endpointRule2: 0.6, endpointRule3: 15 };
$('btnResetEndpoint').onclick = () => {
  endpointRule1.value = String(Math.round(ENDPOINT_DEFAULTS.endpointRule1 * 10));
  endpointVal1.textContent = ENDPOINT_DEFAULTS.endpointRule1.toFixed(1) + 's';
  endpointRule2.value = String(Math.round(ENDPOINT_DEFAULTS.endpointRule2 * 10));
  endpointVal2.textContent = ENDPOINT_DEFAULTS.endpointRule2.toFixed(1) + 's';
  endpointRule3.value = String(ENDPOINT_DEFAULTS.endpointRule3);
  endpointVal3.textContent = ENDPOINT_DEFAULTS.endpointRule3 + 's';
  sendEndpoint();
};

chkShowPrev.onchange = () => {
  savePrefs({ showPrev: chkShowPrev.checked });
  chrome.runtime.sendMessage({ type: 'SET_PREV_OPTS', showPrev: chkShowPrev.checked, prevOpacity: parseInt(prevOpacitySlider.value) }).catch(() => {});
};

prevOpacitySlider.oninput = () => {
  const v = parseInt(prevOpacitySlider.value);
  prevOpacityLabel.textContent = String(v);
  savePrefs({ prevOpacity: v });
  chrome.runtime.sendMessage({ type: 'SET_PREV_OPTS', showPrev: chkShowPrev.checked, prevOpacity: v }).catch(() => {});
};

fontSizeSlider.oninput = () => {
  fontSizeLabel.textContent = fontSizeSlider.value;
  const size = parseInt(fontSizeSlider.value);
  chrome.runtime.sendMessage({ type: 'SET_FONT_SIZE', fontSize: size }).catch(() => {});
  savePrefs({ fontSize: size });
};

chrome.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {
    case 'TEXT_CHANGED':
      textPreview.innerHTML = `<div class="current-text">${escapeHtml(msg.text) || '...'}</div>`;
      break;
    case 'SENTENCE_DONE': {
      const el = document.createElement('div');
      el.className = 'sentence';
      el.textContent = msg.text;
      textPreview.prepend(el);
      if (textPreview.children.length > 10) textPreview.lastElementChild?.remove();
      transcriptEntries.push(msg.text);
      renderTranscript();
      break;
    }
    case 'STATUS_CHANGED':
      setStatus(msg.status);
      break;
    case 'LOG':
      log(msg.message);
      break;
    case 'ERROR':
      log(`错误: ${msg.message}`);
      setStatus('Stopped');
      break;
    case 'LOCK_CHANGED':
      locked = msg.locked;
      updateLockUI();
      break;
  }
});

function escapeHtml(s: string): string {
  const d = document.createElement('div');
  d.textContent = s; return d.innerHTML;
}

loadPrefs();
loadTranscript();
applyLang();
chrome.storage.local.get('tmspeech_use_punct').then(r => {
  chkPunct.checked = r['tmspeech_use_punct'] !== false;
});
// 坑：GET_STATUS 的 locked 现由 bg 异步回源 storage 后 sendResponse（处理器 return true），
// promise 仍会正常 resolve，但响应晚于同步分支——此处不得假设响应同步可达。
chrome.runtime.sendMessage({ type: 'GET_STATUS' }).then((resp: any) => {
  if (resp?.status) setStatus(resp.status);
  if (resp?.locked !== undefined) { locked = resp.locked; updateLockUI(); }
}).catch(() => {});
