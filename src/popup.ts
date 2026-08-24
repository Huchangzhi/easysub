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
// —— 历史检索 ——
const searchInput = $('searchInput') as HTMLInputElement;
const searchCount = $('searchCount');
const btnSearchClear = $('btnSearchClear') as HTMLButtonElement;
// —— 新功能开关 ——
const chkLookback = $('chkLookback') as HTMLInputElement;
const chkLatency = $('chkLatency') as HTMLInputElement;
// —— Hero 状态卡 / 主题系统 ——
const hero = $('heroCard');
const statusWordEl = $('statusWord');
const timerEl = $('sessionTimer');
// —— 波形 / 叠层外观 ——
const waveCanvas = $('waveCanvas') as HTMLCanvasElement;
const chkWaveform = $('chkWaveform') as HTMLInputElement;
// —— 时间戳显示开关 ——
const chkShowTs = $('chkShowTs') as HTMLInputElement;

let locked = false;
let lastStatus = 'Stopped';
let hasStarted = false; // 是否启动过识别：区分 Hero 卡「待命」与「已停止」两种静止态
let currentLang = 'zh_CN';
// 坑：t19 起存储契约升级为 {text, ts}（ts=Date.now()，0=legacy 无时标哨兵）——
// 读取必须做 string→{text,ts:0} 懒归一化（bg 同款逻辑），否则 .text/.ts 是 undefined 直接炸 UI
interface TranscriptEntry { text: string; ts: number }
let transcriptEntries: TranscriptEntry[] = [];
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
  // —— 历史检索 + 新功能开关（文案随语言切换实时刷新）——
  searchInput.setAttribute('placeholder', tr('searchPlaceholder'));
  $('showLookback').textContent = tr('showLookback');
  $('helpTipLookback').textContent = tr('helpLookback');
  $('showLatency').textContent = tr('showLatency');
  $('helpTipLatency').textContent = tr('helpLatency');
  // —— 外观主题（色板名/分段控件名随语言切换，统一走 data-key 委托）——
  $('appearanceLabel').textContent = tr('appearanceLabel');
  $('overlayBgLabel').textContent = tr('overlayBgLabel');
  document.querySelectorAll<HTMLElement>('[data-key]').forEach(el => {
    if (el.dataset.key) el.textContent = tr(el.dataset.key);
  });
  $('showWaveform').textContent = tr('showWaveform');
  $('helpTipWaveform').textContent = tr('helpWaveform');
  $('showTimestamps').textContent = tr('showTimestamps');
  $('helpTipTimestamps').textContent = tr('helpTimestamps');
  $('helpTipAppearance').textContent = tr('helpAppearance');
  $('helpTipOverlayBg').textContent = tr('helpOverlayBg');
  // Hero 大状态词也要跟随语言刷新（依据最近一次状态与是否启动过）
  statusWordEl.textContent = tSync(currentLang,
    lastStatus === 'Running' ? 'stateRunning' : (hasStarted ? 'stateStopped' : 'stateReady'));
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
  // 新功能开关默认开（!== false），与 savePrefs 的合并语义配合：
  // 老用户 storage 里没有这两个键，首次打开即为默认开启
  chkLookback.checked = prefs.lookbackEnabled !== false;
  chkLatency.checked = prefs.latencyIndicatorEnabled !== false;
  // 坑：字幕开关必须从 prefs 恢复——此前勾选态永远回到 HTML 默认 checked，
  // 与上次会话的真实可见性脱节（START 时才把当次值带上，用户上次的选择丢失）。
  // 键名 overlayVisible 与 START 消息的 msg.overlayVisible 对齐；默认开（!== false）。
  chkOverlay.checked = prefs.overlayVisible !== false;
  // 主题：白名单校验，storage 被手改成未知值时回退 cyan（body 无匹配 data-theme
  // 时 CSS 变量自然落到 :root 默认组，不会出现无色控件）
  const theme = THEMES.includes(prefs.accentTheme) ? prefs.accentTheme : DEFAULT_THEME;
  applyTheme(theme);
  // 叠层外观三模式（契约与 content.ts t18 对齐：glass 默认/solid/outline）
  const bm = BG_MODES.includes(prefs.overlayBgMode) ? prefs.overlayBgMode : 'glass';
  applyBgMode(bm);
  chkWaveform.checked = prefs.waveformEnabled !== false;
  updateWaveVisibility();
  // 时间戳显示默认开；切换只影响 popup 渲染，不进 FORWARD 链路
  chkShowTs.checked = prefs.showTimestamps !== false;
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

// —— C. 主题系统：切 body[data-theme] 换 CSS 变量组，纯属性切换零重排成本 ——
const DEFAULT_THEME = 'cyan';
// 坑：与 popup.html 中五个 .swatch 的 data-theme 一一对应；新增色板要两处同步
const THEMES = ['cyan', 'emerald', 'violet', 'amber', 'rose'];
// 波形当前柱颜色缓存：rAF 每帧读 getComputedStyle 太贵，主题切换时才刷新一次
let accentCache = '#5e9eff';

function applyTheme(theme: string) {
  document.body.dataset.theme = theme;
  document.querySelectorAll<HTMLButtonElement>('.swatch').forEach(b => {
    const on = b.dataset.theme === theme;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  });
  accentCache = getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#5e9eff';
}

document.querySelectorAll<HTMLButtonElement>('.swatch').forEach(b => {
  b.onclick = () => {
    const t = b.dataset.theme!;
    applyTheme(t);
    savePrefs({ accentTheme: t });
  };
});

// —— 叠层外观三模式（契约：overlayBgMode ∈ 'glass'|'solid'|'outline'，字段名勿改）——
// 坑：与 content.ts t18 的 BG_MODES 白名单保持一致，新增模式要两处同步
const BG_MODES = ['glass', 'solid', 'outline'];

function applyBgMode(mode: string) {
  document.querySelectorAll<HTMLButtonElement>('.seg').forEach(b => {
    const on = b.dataset.bgmode === mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  });
}

document.querySelectorAll<HTMLButtonElement>('.seg').forEach(b => {
  b.onclick = () => {
    const m = b.dataset.bgmode!;
    applyBgMode(m);
    savePrefs({ overlayBgMode: m });
    // 运行中即时生效走既有 PREFS_PATCH 转发链路（bg 只转发 payload）
    chrome.runtime.sendMessage({
      type: 'FORWARD_TO_CONTENT',
      payload: { type: 'PREFS_PATCH', overlayBgMode: m },
    }).catch(() => {});
  };
});

// —— A. 实时波形条：LEVEL 消息入环形采样，rAF 仅在打开+Running 时重绘 ——
const LEVEL_BARS = 60; // 保留最近 60 个采样（~120ms/条 ≈ 7 秒历史）
let levels: number[] = [];
let waveRaf = 0;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function drawWave() {
  const dpr = window.devicePixelRatio || 1;
  const cssW = waveCanvas.clientWidth || 300;
  const cssH = 28;
  // 坑：canvas 位图尺寸必须含 dpr，否则高分屏上波形模糊；容器宽变化（罕见）时重设
  if (waveCanvas.width !== Math.round(cssW * dpr)) {
    waveCanvas.width = Math.round(cssW * dpr);
    waveCanvas.height = Math.round(cssH * dpr);
  }
  const ctx = waveCanvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const gap = 2;
  const barW = (cssW - gap * (LEVEL_BARS - 1)) / LEVEL_BARS;
  const mid = cssH / 2;
  for (let i = 0; i < LEVEL_BARS; i++) {
    const v = levels[i] ?? 0;
    // 静止基线：无数据时也画 2px 小柱，避免空白块突兀
    const barH = Math.max(2, v * (cssH - 2));
    ctx.fillStyle = i === LEVEL_BARS - 1 ? accentCache : 'rgba(255, 255, 255, 0.22)';
    ctx.fillRect(i * (barW + gap), mid - barH / 2, barW, barH);
  }
}

function startWave() {
  // 坑：先 cancel 再启——Running 抖动会连发 startWave，不清旧 rAF 会叠多个循环越画越快
  stopWaveLoop();
  if (!chkWaveform.checked || lastStatus !== 'Running') { drawWave(); return; }
  if (reduceMotion.matches) { drawWave(); return; } // 减弱动态：只随 LEVEL 消息事件驱动重绘
  const loop = () => { drawWave(); waveRaf = requestAnimationFrame(loop); };
  waveRaf = requestAnimationFrame(loop);
}

function stopWaveLoop() {
  if (waveRaf) { cancelAnimationFrame(waveRaf); waveRaf = 0; }
}

function updateWaveVisibility() {
  waveCanvas.style.display = chkWaveform.checked ? '' : 'none';
  levels = []; // 关闭再开从空基线起步，不残留旧形状
  if (lastStatus === 'Running' && chkWaveform.checked) startWave();
  else { stopWaveLoop(); if (chkWaveform.checked) drawWave(); }
}

chkWaveform.onchange = () => {
  savePrefs({ waveformEnabled: chkWaveform.checked });
  updateWaveVisibility();
};

chkShowTs.onchange = () => {
  // 只影响 popup 渲染层，storage 权威数据不动；即时重渲染无需 FORWARD
  savePrefs({ showTimestamps: chkShowTs.checked });
  renderTranscript();
};

// —— 会话计时：全面板仅此一个 interval ——
let timerId: number | undefined = undefined;
let runStartTs = 0;

function fmtDuration(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// 坑：必须先清后启——Running/Stopped 短时间抖动会连发 setStatus，
// 不清旧 interval 会叠加出多个每秒回调，计时越走越快且停止后仍在跑
function startTimer(baseTs?: number) {
  stopTimer(false);
  // 坑：计时基准优先用 bg 下发的 startedAt（会话真实开始时刻，纳入 storage.session
  // 快照、SW 重启可恢复）——否则 popup 每次打开都从 00:00 重计，与"已进行时长"不符；
  // 无戳（旧版本 bg/异常路径）才退回本地时刻，行为与旧版一致
  runStartTs = baseTs && baseTs > 0 ? baseTs : Date.now();
  timerEl.textContent = fmtDuration(Math.floor((Date.now() - runStartTs) / 1000));
  timerId = window.setInterval(() => {
    timerEl.textContent = fmtDuration(Math.floor((Date.now() - runStartTs) / 1000));
  }, 1000);
}

function stopTimer(resetDisplay: boolean) {
  if (timerId !== undefined) { clearInterval(timerId); timerId = undefined; }
  if (resetDisplay) timerEl.textContent = '00:00';
}

function setStatus(status: string, startedAt?: number) {
  statusDot.className = 'status-dot ' + status;
  btnStart.disabled = status === 'Running';
  btnStop.disabled = status === 'Stopped';
  // 记录当前会话态，供 chkOverlay 切换时判断"是否处于运行中"以给出对应反馈
  lastStatus = status;
  // Hero 卡联动：光晕描边 + 大状态词（待命→聆听中→已停止）+ 计时启停
  hero.classList.toggle('Running', status === 'Running');
  if (status === 'Running') {
    hasStarted = true;
    statusWordEl.textContent = tSync(currentLang, 'stateRunning');
    // 坑：必须把 bg 下发的 startedAt 传给计时器——写死 startTimer() 会以"收到这条
    // 消息的时刻"为基线，重开面板计时归零、跨面板不连续
    startTimer(startedAt);
    startWave();
  } else {
    // 停止即冻结并清零计时；波形停循环并画静止基线（ERROR 也走这里，同样停表）
    stopTimer(true);
    stopWaveLoop();
    levels = [];
    if (chkWaveform.checked) drawWave();
    statusWordEl.textContent = tSync(currentLang, hasStarted ? 'stateStopped' : 'stateReady');
  }
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
  if (!tabId) { log(tSync(currentLang, 'noActiveTab')); return; }

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
  if (lastStatus !== 'Running') {
    log(tSync(currentLang, 'overlaySavedOffline'));
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
  // 坑：legacy 纯字符串与新版 {text,ts} 可能混存，读取必须懒归一化（同 bg 逻辑），
  // 否则老用户升级后首次打开 popup 就在渲染层炸 undefined
  transcriptEntries = ((r[TRANSCRIPT_KEY] as unknown[]) || []).map(e =>
    typeof e === 'string' ? { text: e, ts: 0 } : { text: String((e as any)?.text ?? ''), ts: Number((e as any)?.ts) || 0 }
  );
  renderTranscript();
}

function saveTranscript() {
  chrome.storage.local.set({ [TRANSCRIPT_KEY]: transcriptEntries });
}

function renderTranscript() {
  if (transcriptEntries.length === 0) {
    // 空态：内联 SVG 图标 + 主句 + 双语提示语，垂直居中（样式见 .transcript-empty）
    transcriptBox.innerHTML = `<div class="transcript-empty" id="transcriptEmpty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      <span>${tSync(currentLang, 'transcriptEmpty')}</span>
      <small>${tSync(currentLang, 'transcriptHint')}</small></div>`;
    return;
  }
  const q = searchInput.value.trim().toLowerCase();
  if (!q) {
    // 无搜索词：原样全量渲染（清空搜索框后 DOM 完全复原走这里）
    transcriptBox.innerHTML = transcriptEntries.map(t =>
      `<div class="transcript-entry">${renderEntryHtml(t)}</div>`
    ).join('');
    transcriptBox.scrollTop = transcriptBox.scrollHeight;
    return;
  }
  // 搜索态：纯内存过滤（数组 ≤1000 条），input 直接重渲，无防抖/无新常驻开销
  const hits = transcriptEntries.filter(t => t.text.toLowerCase().includes(q));
  if (hits.length === 0) {
    transcriptBox.innerHTML = `<div class="transcript-empty">${tSync(currentLang, 'searchNoMatch')}</div>`;
    return;
  }
  transcriptBox.innerHTML = hits.map(t =>
    `<div class="transcript-entry">${renderEntryHtml(t, q)}</div>`
  ).join('');
}

// 单条渲染：时间戳（相对本会话第一条带时标条目的 [mm:ss] 偏移）+ 正文
function renderEntryHtml(entry: TranscriptEntry, q?: string): string {
  // 坑：origin 曾取 transcriptEntries[0].ts——升级用户的存储里首条往往是 legacy(ts=0)，
  // 会把整个列表的时间戳全部误伤抑制。改为取首条 ts>0 的条目做会话零点；
  // 自身 ts=0（legacy/转发缺戳兜底）的条目仍单独不显示时标
  const origin = transcriptEntries.find(t => t.ts > 0)?.ts || 0;
  let html = '';
  if (chkShowTs.checked && entry.ts > 0 && origin > 0) {
    const sec = Math.max(0, Math.round((entry.ts - origin) / 1000));
    const mm = String(Math.floor(sec / 60)).padStart(2, '0');
    const ss = String(sec % 60).padStart(2, '0');
    html += `<span class="entry-ts">[${mm}:${ss}]</span> `;
  }
  html += (q ? highlightEntry(entry.text, q) : escapeHtml(entry.text));
  return html;
}

// 坑：高亮必须"按原文切分、逐段转义后再拼 <mark>"——若先整体 escapeHtml 再替换
// 原始查询词，查询含 &/</> 时会与已转义实体错位，产生错误高亮甚至注入点
function highlightEntry(text: string, q: string): string {
  let out = '';
  let last = 0;
  const lower = text.toLowerCase();
  while (true) {
    const i = lower.indexOf(q, last);
    if (i < 0) break;
    out += escapeHtml(text.slice(last, i)) + '<mark>' + escapeHtml(text.slice(i, i + q.length)) + '</mark>';
    last = i + q.length;
  }
  return out + escapeHtml(text.slice(last));
}

// —— 搜索框交互：仅 input 事件触发重渲；命中计数只在有搜索词时显示 ——
searchInput.oninput = () => {
  btnSearchClear.style.display = searchInput.value ? 'flex' : 'none';
  renderTranscript();
  const q = searchInput.value.trim().toLowerCase();
  if (!q) { searchCount.textContent = ''; return; }
  const n = transcriptEntries.filter(t => t.text.toLowerCase().includes(q)).length;
  searchCount.textContent = tSync(currentLang, 'searchHits').replace('{n}', String(n));
};

btnSearchClear.onclick = () => {
  searchInput.value = '';
  searchCount.textContent = '';
  btnSearchClear.style.display = 'none';
  renderTranscript();
  searchInput.focus();
};

btnCopy.onclick = async () => {
  // 复制只拼纯文本，不带时间戳（时标仅用于屏上回看）
  const text = transcriptEntries.map(t => t.text).join('\n');
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
  // 清空记录时一并复位搜索框——否则残留的搜索词让空态显示成"没有匹配的字幕"，误导用户
  searchInput.value = '';
  searchCount.textContent = '';
  btnSearchClear.style.display = 'none';
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
  initRangeFills(); // 程序化赋值不触发 input 事件，填充色需手动刷新
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

// —— 滑杆填充：已选区间染 accent 色，仅 init/input 时重算，无定时器/无轮询 ——
function updateRangeFill(el: HTMLInputElement) {
  const min = parseFloat(el.min) || 0;
  const max = parseFloat(el.max) || 100;
  const p = ((parseFloat(el.value) - min) / (max - min)) * 100;
  // 坑：Webkit 无法按 value 动态给 range 轨道着色（-webkit-slider-runnable-track
  // 不接受动态进度），只能内联 linear-gradient 双色硬断点模拟填充；
  // 百分比 toFixed(2) 消浮点尾巴，避免断点处出现 1px 锯齿
  el.style.background = `linear-gradient(to right, var(--accent) ${p.toFixed(2)}%, var(--border) ${p.toFixed(2)}%)`;
}
function initRangeFills() {
  document.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach(updateRangeFill);
}
// addEventListener 与上方 .oninput 赋值互不覆盖，两个监听都会触发
document.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach(el => {
  el.addEventListener('input', () => updateRangeFill(el));
});
initRangeFills(); // 先按 HTML 默认值兜底；storage 异步读回后再刷一次真实值

// 坑：bg 的 FORWARD_TO_CONTENT 处理器只转发 msg.payload 给 content，
// PREFS_PATCH 必须整体放进 payload；字段名是 popup↔content 的显示契约
// （content 端由 auditor-ui 并行实现），勿改键名，否则运行中切换静默失效
chkLookback.onchange = () => {
  savePrefs({ lookbackEnabled: chkLookback.checked });
  chrome.runtime.sendMessage({
    type: 'FORWARD_TO_CONTENT',
    payload: { type: 'PREFS_PATCH', lookbackEnabled: chkLookback.checked },
  }).catch(() => {});
};

chkLatency.onchange = () => {
  savePrefs({ latencyIndicatorEnabled: chkLatency.checked });
  chrome.runtime.sendMessage({
    type: 'FORWARD_TO_CONTENT',
    payload: { type: 'PREFS_PATCH', latencyIndicatorEnabled: chkLatency.checked },
  }).catch(() => {});
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
      // 坑：bg 转发的 SENTENCE_DONE 可能不带 ts（旧版本/异常路径），归零走 legacy
      // 渲染（无时标）；storage 里的权威条目由 bg appendTranscript 统一写 ts
      transcriptEntries.push({ text: String(msg.text ?? ''), ts: Number(msg.ts) || 0 });
      renderTranscript();
      break;
    }
    case 'LEVEL': {
      // 坑：v 可能越界/非数值（测量端异常），钳到 [0,1] 防画布炸
      const v = Math.max(0, Math.min(1, Number(msg.v) || 0));
      levels.push(v);
      if (levels.length > LEVEL_BARS) levels.shift();
      // 减弱动态模式下无 rAF 循环，随消息事件驱动重绘（~120ms 一条，足够顺滑）
      if (reduceMotion.matches && lastStatus === 'Running' && chkWaveform.checked) drawWave();
      break;
    }
    case 'STATUS_CHANGED':
      // bg 会在 Running 转发里附带 startedAt（会话真实开始时刻），用于校准计时基准
      setStatus(msg.status, msg.startedAt);
      break;
    case 'LOG':
      log(msg.message);
      break;
    case 'ERROR':
      // 坑：errorPrefix 的 {m} 是占位符，须手动 replace（与 searchHits 同一套约定）
      log(tSync(currentLang, 'errorPrefix').replace('{m}', String(msg.message)));
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

loadPrefs().then(initRangeFills); // storage 值写回滑杆后再刷填充色
loadTranscript();
applyLang();
chrome.storage.local.get('tmspeech_use_punct').then(r => {
  chkPunct.checked = r['tmspeech_use_punct'] !== false;
});
// 坑：GET_STATUS 的 locked 现由 bg 异步回源 storage 后 sendResponse（处理器 return true），
// promise 仍会正常 resolve，但响应晚于同步分支——此处不得假设响应同步可达。
chrome.runtime.sendMessage({ type: 'GET_STATUS' }).then((resp: any) => {
  // 坑：status 缺失（响应异常）时不得调 setStatus——undefined 会落进 else 分支误显 Stopped
  if (resp?.status) setStatus(resp.status, resp.startedAt);
  if (resp?.locked !== undefined) { locked = resp.locked; updateLockUI(); }
}).catch(() => {});
