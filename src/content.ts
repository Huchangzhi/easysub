import { tSync } from './i18n';
console.log('[TM Content] loaded');
// 坑：background 可能在同一页面重复注入本脚本（启动重试、导航重注入竞态）。
// 这里刻意不用 window 标记拦截重复副本——扩展重载后旧标记会残留，把新副本误杀，
// 导致该页字幕失效到手动刷新为止。正确策略是"后来者接管"：
// create() 会按 DOM id 移除旧节点，消息处理全部幂等，多副本并存也只显示一层字幕。

let overlay: HTMLDivElement | null = null;
let prevEl: HTMLDivElement | null = null;
let textEl: HTMLDivElement | null = null;
let transEl: HTMLDivElement | null = null; // 实时翻译行（可选，位于当前句下方）
let prevTransEl: HTMLDivElement | null = null; // 上一句最终译文行（可选，位于上一句展示区下方）
let lockBtn: HTMLButtonElement | null = null;
let _locked = false;
let _showPrev = true;
let _prevOpacity = 0.35;
let _pendingText = '';
// 最近一次 SENTENCE_DONE 的句序号（offscreen 下发；0=尚未见到完成句）。
// 当前句序号 = lastDoneSeq + 1，译文消息按序号路由到当前句行或上一句行。
let lastDoneSeq = 0;
// —— 近句回看（走神回看）——
// 坑：回看缓冲刻意只放内存、不写任何 storage——转写内容可能涉及隐私，
// 页面销毁即随 DOM 一并丢弃；跨会话留痕交给 popup 里已有的 tmspeech_transcript。
const RECENT_MAX = 10;
// 回看缓冲条目：原文 + 定稿译文（译文随原句配对，不再是独立条目，避免中英顺序错位）
let recentSentences: { text: string; tr?: string }[] = []; // 新句在前（unshift），环形截断到 RECENT_MAX
let reviewBtn: HTMLButtonElement | null = null;
let reviewPanel: HTMLDivElement | null = null;
let reviewOpen = false;
let reviewCloseTimer: ReturnType<typeof setTimeout> | null = null;
let _lang = 'zh_CN'; // 供回看把手 aria-label 等 UI 文案取词
// —— 功能开关（tmspeech_prefs.lookbackEnabled / latencyIndicatorEnabled，默认 true）——
// popup 侧开关由 ui-engineer 实现：改设置经 FORWARD_TO_CONTENT 推 PREFS_PATCH 过来，
// 这里只合并内存并即时生效；持久化归 popup 的 savePrefs，content 不回写以免竞争其读改写。
let _lookbackEnabled = true;
let _latencyEnabled = true;
// —— 叠层外观三模式（tmspeech_prefs.overlayBgMode，默认 'glass' 兼容老用户）——
type OverlayBgMode = 'glass' | 'solid' | 'outline';
const BG_MODES: OverlayBgMode[] = ['glass', 'solid', 'outline'];
let _overlayBgMode: OverlayBgMode = 'glass';
// —— 延迟指示器 ——
// 颜色阈值（调整入口）：绿=优秀 <LATENCY_LOW_MS；黄=中 LOW–HIGH；红=高 >HIGH。改这里即可全局生效。
const LATENCY_LOW_MS = 200;
const LATENCY_HIGH_MS = 1000;
const LATENCY_GREEN = '#34c759';
const LATENCY_YELLOW = '#ffcc00';
const LATENCY_RED = '#ff3b30';
let _lastLatencyMs: number | null = null; // 仅在收到 LATENCY_UPDATE 时更新，无常驻定时器
let latencyWrap: HTMLDivElement | null = null;
let latencyDot: HTMLDivElement | null = null;
let latencyText: HTMLSpanElement | null = null;
let latencyTip: HTMLDivElement | null = null;
let dragState: {
  baseLeft: number; baseTop: number;
  startX: number; startY: number;
} | null = null;

const STORAGE_KEY = 'tmspeech_overlay';

const LOCK_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 1 1 8 0v4"/></svg>';
const UNLOCK_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8.5 11V7a3.5 3.5 0 0 1 6.5-2"/></svg>';
const CHEVRON_UP_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>';
const CHEVRON_DOWN_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

function saveState() {
  // 坑：回看面板展开时叠层的 offsetHeight 含面板（max-height 40vh 可变高），
  // 此刻保存的 height 落盘后，下次恢复会把收起态的字幕框撑成一坨空白——
  // 展开期间跳过保存即可（位置 left/top 在拖拽释放时另行保存，不受影响）。
  if (!overlay || reviewOpen) return;
  chrome.storage.local.set({
    [STORAGE_KEY]: {
      left: overlay.style.left,
      top: overlay.style.top,
      width: overlay.style.width,
      height: overlay.style.height,
    },
  });
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 200);
}

function create() {
  if (overlay) return;
  overlay = document.createElement('div');
  overlay.id = 'tmspeech-overlay';
  const s = overlay.style;
  s.position = 'fixed';
  s.zIndex = '2147483647';
  s.padding = '24px 32px';
  s.background = 'rgba(10,10,20,0.75)';
  s.backdropFilter = 'blur(16px) saturate(180%)';
  (s as any).webkitBackdropFilter = 'blur(16px) saturate(180%)';
  s.borderRadius = '16px';
  s.border = '1px solid rgba(255,255,255,0.08)';
  s.minWidth = '200px';
  s.maxWidth = '900px';
  s.overflow = 'hidden';
  s.userSelect = 'none';
  s.fontFamily = 'system-ui,-apple-system,sans-serif';
  s.boxShadow = '0 8px 48px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.04)';
  s.left = '50%';
  s.top = '50%';
  s.transform = 'translate(-50%, -50%)';
  // 坑：上面内联样式写死的是 glass 观感，而 paintOverlayChrome 此前只在下方异步
  // storage 回调里才跑——solid/outline 用户每次创建叠层都会先闪一帧旧毛玻璃再切换。
  // 同步体内按当前 _overlayBgMode 立即重涂一次（函数声明提升，可直接调用）；
  // 异步回调读到的 prefs 若不同会再次覆盖，最终值不受影响
  paintOverlayChrome();

  chrome.storage.local.get('tmspeech_locked').then(r => {
    if (r.tmspeech_locked) { _locked = true; applyLock(); }
  });

  chrome.storage.local.get('tmspeech_prefs').then(r => {
    const prefs = (r['tmspeech_prefs'] as any) || {};
    _showPrev = prefs.showPrev !== false;
    _prevOpacity = (prefs.prevOpacity ?? 35) / 100;
    // 初始开关值：与 popup 的 PREFS_PATCH 推送同源（tmspeech_prefs），默认 true
    _lookbackEnabled = prefs.lookbackEnabled !== false;
    _latencyEnabled = prefs.latencyIndicatorEnabled !== false;
    // 外观模式初始值（默认 'glass' 兼容老用户；非法值一律回退 glass）
    const bgMode = prefs.overlayBgMode as OverlayBgMode;
    if (BG_MODES.includes(bgMode)) _overlayBgMode = bgMode;
    applyFeatureToggles();
    paintOverlayChrome();
  });

  prevEl = document.createElement('div');
  textEl = document.createElement('div');
  chrome.storage.local.get(['tmspeech_prefs', 'tmspeech_lang']).then(r => {
    const prefs = (r['tmspeech_prefs'] as any) || {};
    _lang = (r['tmspeech_lang'] as string) || 'zh_CN';
    const lang = (r['tmspeech_lang'] as string) || 'zh_CN';
    const fs = prefs.fontSize || 36;
    // 字幕文字阴影随外观模式走：outline 模式靠多向描边阴影保证任意背景可读
    const baseStyle = `color:#fff;font-size:${fs}px;font-weight:600;line-height:1.4;text-shadow:${subtitleShadow()};word-break:break-word;`;
    if (prevEl) {
      prevEl.style.cssText = baseStyle;
      prevEl.style.display = 'none';
      prevEl.style.opacity = String(_prevOpacity);
    }
    if (textEl) {
      textEl.style.cssText = baseStyle;
      textEl.textContent = tSync(lang, 'loadingModel');
      // ponytail: _pendingText 处理 TEXT_CHANGED 先于 overlay 创建（重连时），create 后立即替换
      if (_pendingText) { textEl.textContent = _pendingText; _pendingText = ''; }
    }
    if (transEl) {
      transEl.style.fontSize = Math.round(fs * 0.6) + 'px';
      transEl.style.textShadow = subtitleShadow();
    }
  });
  overlay.appendChild(prevEl);
  overlay.appendChild(textEl);

  // 翻译行：跟随字幕字号缩放、随外观模式取描边阴影；无翻译时隐藏不占位
  transEl = document.createElement('div');
  transEl.style.cssText = [
    'color:#8ec9ff;font-weight:500;line-height:1.4;margin-top:2px;',
    'word-break:break-word;display:none;',
  ].join('');
  overlay.appendChild(transEl);

  // 上一句最终译文行：跟随上一句展示区（prevEl）的透明度基调，字号同当前句译文
  prevTransEl = document.createElement('div');
  prevTransEl.style.cssText = [
    'color:#8ec9ff;font-weight:500;line-height:1.4;margin-top:1px;',
    'word-break:break-word;display:none;',
  ].join('');
  overlay.appendChild(prevTransEl);

  addLockButton();
  // 开关默认开，先按内存偏好挂载；prefs 异步到达后 applyFeatureToggles 会校正
  // （关闭则整体拆除 DOM，不留监听开销）。
  if (_lookbackEnabled) addReviewHandle();
  if (_latencyEnabled) addLatencyIndicator();
  addDragListeners();
  applyLock();
  // 兜底：清掉历史副本可能残留的同 id 节点（如扩展重载前的旧实例），防止视觉上叠加
  document.getElementById('tmspeech-overlay')?.remove();
  mountOverlay();

  chrome.storage.local.get(STORAGE_KEY).then(stored => {
    if (!overlay) return;
    const d = (stored[STORAGE_KEY] as any) || {};
    if (d.left) overlay.style.left = d.left;
    if (d.top) overlay.style.top = d.top;
    if (d.width) overlay.style.width = d.width;
    if (d.height) overlay.style.height = d.height;
    if (d.left || d.top) {
      overlay.style.transform = 'none';
    }
  });

  new ResizeObserver(() => scheduleSave()).observe(overlay);
}

function addLockButton() {
  lockBtn = document.createElement('button');
  lockBtn.innerHTML = LOCK_SVG;
  lockBtn.style.cssText = [
    'position:absolute;top:6px;right:6px;width:36px;height:36px;',
    'border-radius:10px;border:none;background:rgba(255,255,255,0.06);',
    'color:rgba(255,255,255,0.5);cursor:pointer;',
    'display:flex;align-items:center;justify-content:center;padding:0;',
    'z-index:2147483647;opacity:0;',
  ].join('');
  overlay!.appendChild(lockBtn);

    overlay!.onmouseenter = () => { if (!_locked) lockBtn!.style.opacity = '1'; };
    overlay!.onmouseleave = () => { if (!_locked) lockBtn!.style.opacity = '0'; };
    if (_locked) lockBtn.style.opacity = '0.25';
    lockBtn.onmouseenter = () => { lockBtn!.style.background = 'rgba(255,255,255,0.12)'; };
    lockBtn.onmouseleave = () => { lockBtn!.style.background = 'rgba(255,255,255,0.06)'; };
  lockBtn.onclick = (e) => { e.stopPropagation(); toggleLock(); };
}

// —— 近句回看把手与展开面板 ——
function renderReviewPanel() {
  if (!reviewPanel) return;
  // 坑：只在展开瞬间对缓冲做一次快照渲染——若随 OVERLAY_TEXT/TEXT_CHANGED 流式重绘，
  // 列表会在用户阅读时不停抖动/跳行。展开后新到句不进视图，下次展开才可见。
  reviewPanel.textContent = '';
  if (recentSentences.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:2px 0;color:rgba(255,255,255,0.45);font-style:italic;';
    empty.textContent = tSync(_lang, 'transcriptEmpty');
    reviewPanel.appendChild(empty);
    return;
  }
  recentSentences.forEach((sentence, i) => {
    const item = document.createElement('div');
    // 全部用 textContent 写入，句子文本来自识别结果，绝不走 innerHTML（防 XSS 注入点）
    item.textContent = sentence.text;
    item.style.cssText = [
      'color:#fff;font-size:13px;font-weight:500;line-height:1.5;',
      'word-break:break-word;padding:6px 2px;',
      i > 0 ? 'border-top:1px solid rgba(255,255,255,0.08);' : '',
    ].join('');
    reviewPanel!.appendChild(item);
    // 定稿译文随原句配对显示（蓝色小字，与叠层翻译行同色）
    if (sentence.tr) {
      const tr = document.createElement('div');
      tr.textContent = sentence.tr;
      tr.style.cssText = [
        'color:#8ec9ff;font-size:12px;font-weight:500;line-height:1.4;',
        'word-break:break-word;padding:0 2px 6px;',
      ].join('');
      reviewPanel!.appendChild(tr);
    }
  });
}

function openReview() {
  if (!reviewPanel || !reviewBtn || reviewOpen) return;
  if (reviewCloseTimer) { clearTimeout(reviewCloseTimer); reviewCloseTimer = null; }
  reviewOpen = true;
  renderReviewPanel();
  reviewPanel.style.display = 'block';
  reviewBtn.innerHTML = CHEVRON_DOWN_SVG; // 展开态：箭头向下提示"可收起"
}

function closeReview() {
  if (!reviewPanel || !reviewBtn || !reviewOpen) return;
  reviewOpen = false;
  // 收起即清空展示；缓冲保留（需求 3），下次展开重新快照
  reviewPanel.style.display = 'none';
  reviewPanel.textContent = '';
  reviewBtn.innerHTML = CHEVRON_UP_SVG;
}

function addReviewHandle() {
  if (!overlay) return;
  reviewBtn = document.createElement('button');
  reviewBtn.innerHTML = CHEVRON_UP_SVG;
  reviewBtn.setAttribute('aria-label', tSync(_lang, 'transcript'));
  // 坑：锁定态下 overlay 是 pointerEvents:none，hover 与点击都不会落到任何子元素——
  // 把手与面板必须显式自带 pointerEvents:auto（参照锁按钮的做法），否则回看在锁定态失效，
  // 而"走神回看"恰恰多发生在锁定挂机观看时。cssText 里写死，applyLock 不触碰它们。
  reviewBtn.style.cssText = [
    'position:absolute;top:6px;left:6px;width:28px;height:28px;',
    'border-radius:8px;border:none;background:rgba(255,255,255,0.06);',
    'color:rgba(255,255,255,0.55);cursor:pointer;',
    'display:flex;align-items:center;justify-content:center;padding:0;',
    'z-index:2147483647;pointer-events:auto;opacity:0;',
    'transition:opacity 150ms ease, background 150ms ease;',
  ].join('');
  overlay.appendChild(reviewBtn);

  reviewPanel = document.createElement('div');
  // 面板是 overlay 的普通流内子节点、插在字幕行之前：展开时叠层向上生长（"向上展开"），
  // 且天然跟随拖拽移动、不会被 overlay 的 overflow:hidden 裁掉。
  reviewPanel.style.cssText = [
    'display:none;margin:-10px -16px 14px;padding:8px 14px;',
    'background:rgba(10,10,20,0.85);border:1px solid rgba(255,255,255,0.1);',
    'border-radius:12px;max-height:40vh;overflow-y:auto;user-select:text;',
    'pointer-events:auto;', // 锁定态可用性的另一半：面板本体也必须可交互（可滚动）
    'box-shadow:0 4px 24px rgba(0,0,0,0.4);',
  ].join('');
  overlay.insertBefore(reviewPanel, overlay.firstChild);

  // 可见性：未锁定时随 hover 显隐（与锁按钮一致）；锁定时常驻半透明，保证可发现、可点。
  const syncHandleVisibility = () => {
    if (!reviewBtn) return;
    reviewBtn.style.opacity = _locked ? '0.45' : '0';
  };
  syncHandleVisibility();
  (reviewBtn as any).__syncVisibility = syncHandleVisibility;

  reviewBtn.onmouseenter = () => { reviewBtn!.style.opacity = '1'; openReview(); };
  reviewBtn.onmouseleave = () => {
    syncHandleVisibility();
    // 坑：hover 移出把手的瞬间面板还悬着，立即收起会让人点不到面板内容；
    // 给 180ms 宽限，移入面板则取消关闭。
    if (reviewCloseTimer) clearTimeout(reviewCloseTimer);
    reviewCloseTimer = setTimeout(() => closeReview(), 180);
  };
  reviewPanel.onmouseenter = () => { if (reviewCloseTimer) { clearTimeout(reviewCloseTimer); reviewCloseTimer = null; } };
  reviewPanel.onmouseleave = () => { closeReview(); };
  reviewBtn.onclick = (e) => {
    e.stopPropagation();
    if (reviewOpen) closeReview(); else openReview();
  };
}

// —— 延迟指示器（右下角）——
function latencyLevel(ms: number): number {
  if (ms < LATENCY_LOW_MS) return 0;
  if (ms <= LATENCY_HIGH_MS) return 1;
  return 2;
}

function latencyTipText(lvl: number): string {
  // 坑（t32）：两语言的阈值描述必须与 latencyLevel 的实际阈值(LATENCY_LOW_MS=200/HIGH=1000)一致——
  // 此前英文写的是 <1000/1000-2000/>2000，与真实分档差了一个数量级，已修正
  if (_lang !== 'zh_CN') {
    return ['Low latency (<200ms)', 'Medium latency (200ms-1s)', 'High latency (>1s) - check device resource usage'][lvl];
  }
  return ['延迟优秀（<200ms）', '延迟中（<1s）', `延迟高（≥1s）建议检查设备资源占用`][lvl];
}

// 唯一的刷新入口：仅在收到 LATENCY_UPDATE 或锁态切换时调用（~2s 一次），无常驻定时器
function renderLatency() {
  if (!latencyWrap || !_latencyEnabled || _lastLatencyMs == null) return;
  const lvl = latencyLevel(_lastLatencyMs);
  const color = [LATENCY_GREEN, LATENCY_YELLOW, LATENCY_RED][lvl];
  if (latencyDot) latencyDot.style.background = color;
  if (latencyText) {
    // 显示规则：未锁定=实时毫秒数；锁定=只留色点（完整文案由 hover 提示承担）
    latencyText.style.display = _locked ? 'none' : '';
    latencyText.textContent = `${_lastLatencyMs}ms`;
    latencyText.style.color = color;
  }
  if (latencyTip) latencyTip.textContent = latencyTipText(lvl);
  latencyWrap.style.display = 'flex'; // 首条数据到达才显示，之前不占位不残留
}

function addLatencyIndicator() {
  if (!overlay || latencyWrap) return;
  latencyWrap = document.createElement('div');
  // 坑：锁定态 overlay 是 pointerEvents:none——hover 提示要能响应，
  // 指示器必须像锁按钮一样自带 pointerEvents:auto，否则锁定时 tooltip 永远弹不出来。
  latencyWrap.style.cssText = [
    'position:absolute;bottom:6px;right:6px;display:none;', // 首条数据前隐藏
    'align-items:center;gap:5px;padding:3px 8px;border-radius:999px;',
    'background:rgba(255,255,255,0.07);z-index:2147483647;',
    'pointer-events:auto;cursor:default;',
  ].join('');
  latencyDot = document.createElement('div');
  latencyDot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,0.25);flex-shrink:0;';
  latencyText = document.createElement('span');
  latencyText.style.cssText = 'font-size:11px;font-weight:500;font-variant-numeric:tabular-nums;color:rgba(255,255,255,0.75);';
  latencyTip = document.createElement('div');
  latencyTip.style.cssText = [
    'display:none;position:absolute;bottom:calc(100% + 6px);right:0;',
    'max-width:240px;padding:6px 10px;border-radius:10px;',
    'background:rgba(10,10,20,0.92);border:1px solid rgba(255,255,255,0.12);',
    'color:#fff;font-size:11px;line-height:1.5;text-align:right;',
    'box-shadow:0 4px 16px rgba(0,0,0,0.4);white-space:normal;',
  ].join('');
  latencyWrap.appendChild(latencyDot);
  latencyWrap.appendChild(latencyText);
  latencyWrap.appendChild(latencyTip);
  latencyWrap.onmouseenter = () => { if (latencyTip && _lastLatencyMs != null) latencyTip.style.display = 'block'; };
  latencyWrap.onmouseleave = () => { if (latencyTip) latencyTip.style.display = 'none'; };
  overlay.appendChild(latencyWrap);
  renderLatency();
}

// —— 开关即时生效：按内存偏好挂载/拆除对应 DOM（关闭态零 DOM/监听开销）——
function teardownReview() {
  reviewBtn?.remove(); reviewPanel?.remove();
  reviewBtn = null; reviewPanel = null; reviewOpen = false;
  if (reviewCloseTimer) { clearTimeout(reviewCloseTimer); reviewCloseTimer = null; }
}

function teardownLatency() {
  latencyWrap?.remove();
  latencyWrap = null; latencyDot = null; latencyText = null; latencyTip = null;
}

function applyFeatureToggles() {
  if (!overlay) return;
  if (_lookbackEnabled && !reviewBtn) addReviewHandle();
  if (!_lookbackEnabled && reviewBtn) teardownReview();
  if (_latencyEnabled && !latencyWrap) addLatencyIndicator();
  if (!_latencyEnabled && latencyWrap) teardownLatency();
}

// —— 叠层外观三模式（solid / glass / outline）——
// 字幕文字阴影按模式取值：outline 靠四向+纵向描边阴影保证任意背景下可读，
// 其余模式用常规投影。集中在此，create() 的 baseStyle 与模式切换共用一份定义。
function subtitleShadow(): string {
  if (_overlayBgMode === 'outline') {
    // 极简模式：多向硬描边模拟 1px 描边 + 纵向柔和投影兜底
    return [
      '-2px -2px 3px rgba(0,0,0,0.9)', '2px -2px 3px rgba(0,0,0,0.9)',
      '-2px 2px 3px rgba(0,0,0,0.9)', '2px 2px 3px rgba(0,0,0,0.9)',
      '0 2px 8px rgba(0,0,0,0.85)',
    ].join(',');
  }
  return '0 1px 10px rgba(0,0,0,0.8)';
}

// 叠层"外壳"视觉（背景/毛玻璃/边框/阴影/文字描边）的唯一绘制出口。
// 坑：所有相关属性必须成对设置——background/backdropFilter/-webkit-backdropFilter/
// boxShadow/border 在每个分支都要给全量值，切换模式时不得残留上一模式的单边属性
// （-webkit- 前缀不随标准属性联动，漏一个就出现半透明残影）。
// 坑：锁定态的外壳由 applyLock 独占（transparent/none），本函数在锁定时必须让位——
// 否则 prefs 异步到达/PREFS_PATCH 切换会把已锁定的透明外壳重新涂回有色背景，
// 造成"锁定后仍有半透明背景"的老毛病复发。解锁恢复时 applyLock 会回调本函数重涂。
function paintOverlayChrome() {
  if (!overlay || _locked) return;
  const s = overlay.style;
  switch (_overlayBgMode) {
    case 'solid':
      // 纯色底块：可读性优先，近不透明深色圆角块；无毛玻璃（backdropFilter 关闭）
      s.background = 'rgba(12,12,18,0.96)';
      s.backdropFilter = 'none';
      (s as any).webkitBackdropFilter = 'none';
      s.boxShadow = '0 8px 48px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.06)';
      s.border = '1px solid rgba(255,255,255,0.1)';
      break;
    case 'outline':
      // 极简：无背景无边框，可读性全部交给文字多向描边阴影
      s.background = 'transparent';
      s.backdropFilter = 'none';
      (s as any).webkitBackdropFilter = 'none';
      s.boxShadow = 'none';
      s.border = 'none';
      break;
    case 'glass':
    default:
      // 毛玻璃：现状样式（默认），与 applyLock 解锁态的既有观感一致
      s.background = 'rgba(0,0,0,0.25)';
      s.backdropFilter = 'blur(4px)';
      (s as any).webkitBackdropFilter = 'blur(4px)';
      s.boxShadow = '0 0 0 1px rgba(255,255,255,0.03)';
      s.border = '1px solid rgba(255,255,255,0.06)';
      break;
  }
  // 文字描边随模式同步（prevEl/textEl 可能尚未建好，判空即可）
  const shadow = `text-shadow:${subtitleShadow()};`;
  for (const el of [prevEl, textEl, transEl]) {
    if (!el) continue;
    el.style.cssText = el.style.cssText.replace(/text-shadow:[^;]*;?/, shadow);
  }
}

// 外部入口：切模式并立即重涂。零动画红线：纯静态样式替换，不引入任何 transition。
function applyOverlayStyle(mode: OverlayBgMode) {
  if (!BG_MODES.includes(mode)) return;
  _overlayBgMode = mode;
  paintOverlayChrome();
}

function addDragListeners() {
  if (!overlay) return;

  overlay.onpointerdown = (e) => {
    // 坑：必须用 contains 判定——按钮内部是 SVG 图标，点在图标上时 e.target 是 <svg>/<path>
    // 而非 lockBtn 本身；若漏判会启动拖拽并对 overlay setPointerCapture，
    // 指针被捕获后 click 落不到按钮上，锁定切换在"点图标正中"这一最常见操作下失效。
    // 回看把手同理：点它/点展开面板都不能触发拖拽。
    const t = e.target;
    if (_locked) return;
    if (lockBtn && t instanceof Node && lockBtn.contains(t)) return;
    if ((reviewBtn && t instanceof Node && reviewBtn.contains(t)) ||
        (reviewPanel && t instanceof Node && reviewPanel.contains(t))) return;
    const rect = overlay!.getBoundingClientRect();
    dragState = {
      baseLeft: rect.left,
      baseTop: rect.top,
      startX: e.clientX,
      startY: e.clientY,
    };
    overlay!.setPointerCapture(e.pointerId);
    if (lockBtn) lockBtn.style.opacity = '1';
  };

  overlay.onpointermove = (e) => {
    if (!dragState || _locked) return;
    let dx = e.clientX - dragState.startX;
    let dy = e.clientY - dragState.startY;

    // Rubber-band at viewport edges
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const ow = overlay!.offsetWidth;
    const oh = overlay!.offsetHeight;
    const newLeft = dragState.baseLeft + dx;
    const newTop = dragState.baseTop + dy;
    if (newLeft < 0) dx = -rubberband(-newLeft, vw);
    if (newTop < 0) dy = -rubberband(-newTop, vh);
    if (newLeft + ow > vw) dx = (vw - ow - dragState.baseLeft) + rubberband(newLeft + ow - vw, vw);
    if (newTop + oh > vh) dy = (vh - oh - dragState.baseTop) + rubberband(newTop + oh - vh, vh);

    overlay!.style.transform = `translate(${dx}px, ${dy}px)`;
  };

  overlay.onpointerup = (e) => {
    if (!dragState) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;

    const targetLeft = dragState.baseLeft + dx;
    const targetTop = dragState.baseTop + dy;
    overlay!.style.left = targetLeft + 'px';
    overlay!.style.top = targetTop + 'px';
    overlay!.style.transform = 'none';

    scheduleSave();
    dragState = null;
  };

  overlay.onpointercancel = () => { dragState = null; };
}

// —— 全屏挂载 ——
// 坑：页面进 HTML5 全屏后，浏览器只绘制全屏元素，body 下其他节点（含本叠层）一律不渲染，
// 于是 bilibili 等站全屏视频时字幕被盖掉。必须把叠层迁进 document.fullscreenElement。
// media 元素 append 子节点会被当作回退内容忽略，故就近挂到其祖先容器。
// position:fixed 不随父容器变化，而全屏元素总是铺满视口，left/top 坐标语义不变，
// 已保存的拖拽位置无需换算。
function fullscreenMount(): HTMLElement {
  let el: HTMLElement | null = document.fullscreenElement as HTMLElement | null;
  while (el && /^(VIDEO|AUDIO|IFRAME|EMBED|OBJECT)$/.test(el.tagName)) {
    el = el.parentElement;
  }
  return el || document.body;
}

function mountOverlay() {
  if (!overlay) return;
  fullscreenMount().appendChild(overlay);
}

// 进/出全屏时迁移挂载点（重复副本各自注册，appendChild 幂等，仅一层叠层）
document.addEventListener('fullscreenchange', mountOverlay);

function destroy() {
  if (!overlay) return;
  const el = overlay;
  overlay = null; prevEl = null; textEl = null; lockBtn = null;
  transEl = null; prevTransEl = null;
  // 回看 UI 随叠层销毁；reviewOpen 复位，避免下次 create 误判展开态。
  reviewBtn = null; reviewPanel = null; reviewOpen = false;
  if (reviewCloseTimer) { clearTimeout(reviewCloseTimer); reviewCloseTimer = null; }
  // 延迟指示随叠层销毁并清空数据——会话停止/重建后不得残留上一次的延迟读数。
  latencyWrap = null; latencyDot = null; latencyText = null; latencyTip = null;
  _lastLatencyMs = null;
  if (saveTimer) clearTimeout(saveTimer);
  el.remove();
}

function toggleLock() {
  _locked = !_locked;
  chrome.storage.local.set({ tmspeech_locked: _locked });
  applyLock();
  try { chrome.runtime.sendMessage({ type: 'LOCK_CHANGED_FROM_CONTENT', locked: _locked }).catch(() => {}); } catch {}
}

function applyLock() {
  if (!overlay || !lockBtn) return;
  // 坑：下面两分支的视觉属性必须成对设置——backdropFilter 与 -webkit-backdropFilter、
  // background/boxShadow/border/pointerEvents 都要同时置 none(或恢复) ，单边残留会造成
  // "已锁定但仍见半透明背景/毛玻璃"的错乱观感（-webkit- 前缀属性不随标准属性联动）。
  // 锁态值本身以 storage.local['tmspeech_locked'] 为唯一事实源（bg 会补发 LOCK_TOGGLE），
  // 本函数只负责把 _locked 渲染到 DOM。
  if (_locked) {
    overlay.style.pointerEvents = 'none';
    lockBtn.style.pointerEvents = 'auto';
    overlay.style.background = 'transparent';
    overlay.style.backdropFilter = 'none';
    (overlay.style as any).webkitBackdropFilter = 'none';
    overlay.style.boxShadow = 'none';
    overlay.style.border = 'none';
    overlay.style.cursor = 'default';
    lockBtn.style.opacity = '0.25';
  } else {
    overlay.style.pointerEvents = 'auto';
    lockBtn.style.pointerEvents = '';
    // 外壳（背景/毛玻璃/边框/阴影）交给 paintOverlayChrome 按当前外观模式重涂——
    // 坑：这里若写死 glass 值，解锁瞬间会把 solid/outline 模式打回毛玻璃。
    paintOverlayChrome();
    overlay.style.cursor = 'move';
    lockBtn.style.opacity = '';
  }
  lockBtn.innerHTML = _locked ? UNLOCK_SVG : LOCK_SVG;
  // 回看把手可见性随锁态联动：锁定时常驻半透明（可发现可点），未锁定时回到 hover 显隐。
  (reviewBtn as any)?.__syncVisibility?.();
  // 延迟指示随锁态切换显示模式：未锁定=毫秒数文本，锁定=只留色点（hover 出完整文案）。
  renderLatency();
}

function setText(text: string) {
  if (!textEl) { _pendingText = text; return; }
  textEl.textContent = text;
}

// 上一句译文行的显隐：跟随"显示上一句"开关，且仅当有译文内容
function syncPrevTrans() {
  if (!prevTransEl) return;
  prevTransEl.style.display = (_showPrev && !!prevTransEl.textContent) ? '' : 'none';
}

function setOverlayText(prev: string, current: string) {
  const pe = prevEl, te = textEl;
  if (!pe || !te) return;
  const showPrev = _showPrev && prev;
  pe.textContent = prev;
  pe.style.display = showPrev ? '' : 'none';
  te.textContent = current;
  syncPrevTrans();
}

// 监听扩展断开，自动隐藏字幕
(function monitorExtension() {
  const port = chrome.runtime.connect({ name: 'content' });
  port.onDisconnect.addListener(() => destroy());
})();

chrome.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {
    case 'PING':
      break;
    case 'OVERLAY_TEXT':
      setOverlayText(msg.prev || '', msg.current || '');
      break;
    case 'TEXT_CHANGED':
      setText(msg.text);
      break;
    case 'SENTENCE_DONE':
      // 坑：只收 SENTENCE_DONE 的终版文本入回看缓冲；流式 TEXT_CHANGED 是中间态，
      // 同一句话会反复到达，入缓冲会导致列表里同一句出现多次半成品。此消息此前
      // 未被 content 消费，offscreen 经 FW_CT 照发不误，直接在此接住即可（不动协议）。
      // 回看关闭时不入缓冲（零开销约束：无 DOM 也无数据维护）。
      if (msg.text && _lookbackEnabled) {
        recentSentences.unshift({ text: String(msg.text) });
        if (recentSentences.length > RECENT_MAX) recentSentences.length = RECENT_MAX;
      }
      // 句序号推进：刚完成句的序号由 offscreen 随消息带（seq>0 用真值，缺省按本地计数兜底）。
      // 推进必须放在路由/移交之前，使随后的 TRANSLATION 能正确判"当前句"。
      {
        const seq = Number(msg.seq) || 0;
        lastDoneSeq = seq > 0 ? seq : lastDoneSeq + 1;
      }
      // 换句：手头的当前句译文立即移交"上一句"槽（不用等定稿翻译排完队），当前行清空。
      if (transEl && transEl.textContent) {
        if (prevTransEl) {
          prevTransEl.textContent = transEl.textContent;
          prevTransEl.style.opacity = String(_prevOpacity);
          syncPrevTrans();
        }
        transEl.textContent = '';
      }
      if (transEl) transEl.style.display = 'none';
      break;
    case 'TRANSLATION':
      // 流式译文按句序号路由：当前句（seq === lastDoneSeq+1）进 transEl；
      // 上一句的迟到流式结果（seq === lastDoneSeq）补进 prevTransEl，不再污染当前行。
      if (msg.text) {
        const s = Number(msg.seq) || 0;
        if (s === lastDoneSeq + 1 && transEl) {
          transEl.textContent = msg.text;
          transEl.style.display = '';
        } else if (s === lastDoneSeq && s > 0 && prevTransEl) {
          prevTransEl.textContent = msg.text;
          prevTransEl.style.opacity = String(_prevOpacity);
          syncPrevTrans();
        }
      }
      break;
    case 'TRANSLATION_FINAL':
      // 定稿译文总属于"上一句"（seq === lastDoneSeq）：写入 prevTransEl，
      // 同时配对进回看缓冲（挂到最近一条尚无译文的原句上），并兜底清空当前行。
      if (msg.text) {
        const s = Number(msg.seq) || 0;
        if (s === lastDoneSeq && s > 0) {
          if (prevTransEl) {
            prevTransEl.textContent = msg.text;
            prevTransEl.style.opacity = String(_prevOpacity);
            syncPrevTrans();
          }
          if (transEl) { transEl.textContent = ''; transEl.style.display = 'none'; }
          if (_lookbackEnabled) {
            const target = recentSentences.find(x => !x.tr);
            if (target) target.tr = String(msg.text);
          }
        }
      }
      break;
    case 'LATENCY_UPDATE':
      // auditor-audio 的测量端约 2s 一条（仅 Running 时发送），经 bg 现有 FW_CT 路由到达。
      // 只在此处更新文本/颜色，不新增任何定时器；会话停止走 destroy() 清数据不残留。
      if (typeof msg.ms === 'number' && isFinite(msg.ms)) {
        _lastLatencyMs = Math.max(0, Math.round(msg.ms));
        renderLatency();
      }
      break;
    case 'PREFS_PATCH': {
      // popup 开关经 FORWARD_TO_CONTENT 推来的部分偏好：合并进内存并即时生效。
      // 持久化由 popup 侧 savePrefs 负责，这里刻意不回写 storage，避免与其读改写竞争。
      if (typeof msg.lookbackEnabled === 'boolean') _lookbackEnabled = msg.lookbackEnabled;
      if (typeof msg.latencyIndicatorEnabled === 'boolean') _latencyEnabled = msg.latencyIndicatorEnabled;
      // 外观模式即时切换：合法值经 applyOverlayStyle 重涂（内部校验+锁定让位）
      if (typeof msg.overlayBgMode === 'string') applyOverlayStyle(msg.overlayBgMode as OverlayBgMode);
      applyFeatureToggles();
      break;
    }
    case 'OVERLAY_TOGGLE':
      if (msg.visible) create();
      else destroy();
      break;
    case 'LOCK_TOGGLE':
      _locked = msg.locked;
      applyLock();
      break;
    case 'SET_FONT_SIZE':
      if (prevEl) { prevEl.style.fontSize = msg.fontSize + 'px'; }
      if (textEl) { textEl.style.fontSize = msg.fontSize + 'px'; scheduleSave(); }
      if (transEl) { transEl.style.fontSize = Math.round(msg.fontSize * 0.6) + 'px'; }
      if (prevTransEl) { prevTransEl.style.fontSize = Math.round(msg.fontSize * 0.6) + 'px'; }
      break;
    case 'SET_PREV_OPTS':
      _showPrev = msg.showPrev;
      _prevOpacity = (msg.prevOpacity ?? 35) / 100;
      if (prevEl) prevEl.style.opacity = String(_prevOpacity);
      if (prevTransEl) { prevTransEl.style.opacity = String(_prevOpacity); syncPrevTrans(); }
      break;
    case 'RESET_OVERLAY_POSITION':
      chrome.storage.local.remove(STORAGE_KEY);
      if (overlay) {
        overlay.style.left = '50%';
        overlay.style.top = '50%';
        overlay.style.transform = 'translate(-50%, -50%)';
        overlay.style.width = '';
        overlay.style.height = '';
      }
      break;
  }
});
