const $ = (id: string) => document.getElementById(id)!;

const statusDot = $('statusDot');
const btnStart = $('btnStart') as HTMLButtonElement;
const btnStop = $('btnStop') as HTMLButtonElement;
const chkOverlay = $('chkOverlay') as HTMLInputElement;
const textPreview = $('textPreview');
const modelStatus = $('modelStatus');
const btnLock = $('btnLock') as HTMLButtonElement;
const lockLabel = $('lockLabel');
const fontSizeSlider = $('fontSizeSlider') as HTMLInputElement;
const fontSizeLabel = $('fontSizeLabel');

let locked = false;
const PREFS_KEY = 'tmspeech_prefs';

requestAnimationFrame(() => {
  document.querySelector('.container')?.classList.add('loaded');
});

async function loadPrefs() {
  const r = await chrome.storage.local.get(PREFS_KEY);
  const prefs: Record<string, any> = r[PREFS_KEY] || {};
  if (prefs.fontSize) {
    fontSizeSlider.value = String(prefs.fontSize);
    fontSizeLabel.textContent = String(prefs.fontSize);
  }
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
}

function log(msg: string) {
  modelStatus.textContent = msg;
}

function updateLockUI() {
  const isLocked = locked;
  lockLabel.textContent = isLocked ? '解锁' : '锁定';
  btnLock.innerHTML = isLocked
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8.5 11V7a3.5 3.5 0 0 1 6.5-2"/></svg><span id="lockLabel">解锁</span>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 1 1 8 0v4"/></svg><span id="lockLabel">锁定</span>';
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
  chrome.runtime.sendMessage({ type: 'OVERLAY_TOGGLE', visible: chkOverlay.checked }).catch(() => {});
};

btnLock.onclick = () => {
  locked = !locked;
  chrome.runtime.sendMessage({ type: 'LOCK_TOGGLE', locked }).catch(() => {});
  updateLockUI();
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
chrome.runtime.sendMessage({ type: 'GET_STATUS' }).then((resp: any) => {
  if (resp?.status) setStatus(resp.status);
  if (resp?.locked !== undefined) { locked = resp.locked; updateLockUI(); }
}).catch(() => {});
