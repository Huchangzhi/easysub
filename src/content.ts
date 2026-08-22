import { tSync } from './i18n';
console.log('[TM Content] loaded');
// 坑：background 可能在同一页面重复注入本脚本（启动重试、导航重注入竞态）。
// 这里刻意不用 window 标记拦截重复副本——扩展重载后旧标记会残留，把新副本误杀，
// 导致该页字幕失效到手动刷新为止。正确策略是"后来者接管"：
// create() 会按 DOM id 移除旧节点，消息处理全部幂等，多副本并存也只显示一层字幕。

let overlay: HTMLDivElement | null = null;
let prevEl: HTMLDivElement | null = null;
let textEl: HTMLDivElement | null = null;
let lockBtn: HTMLButtonElement | null = null;
let _locked = false;
let _showPrev = true;
let _prevOpacity = 0.35;
let _pendingText = '';
let dragState: {
  baseLeft: number; baseTop: number;
  startX: number; startY: number;
} | null = null;

const STORAGE_KEY = 'tmspeech_overlay';

const LOCK_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 1 1 8 0v4"/></svg>';
const UNLOCK_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8.5 11V7a3.5 3.5 0 0 1 6.5-2"/></svg>';

function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

function saveState() {
  if (!overlay) return;
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

  chrome.storage.local.get('tmspeech_locked').then(r => {
    if (r.tmspeech_locked) { _locked = true; applyLock(); }
  });

  chrome.storage.local.get('tmspeech_prefs').then(r => {
    const prefs = (r['tmspeech_prefs'] as any) || {};
    _showPrev = prefs.showPrev !== false;
    _prevOpacity = (prefs.prevOpacity ?? 35) / 100;
  });

  prevEl = document.createElement('div');
  textEl = document.createElement('div');
  chrome.storage.local.get(['tmspeech_prefs', 'tmspeech_lang']).then(r => {
    const prefs = (r['tmspeech_prefs'] as any) || {};
    const lang = (r['tmspeech_lang'] as string) || 'zh_CN';
    const fs = prefs.fontSize || 36;
    const baseStyle = `color:#fff;font-size:${fs}px;font-weight:600;line-height:1.4;text-shadow:0 1px 10px rgba(0,0,0,0.8);word-break:break-word;`;
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
  });
  overlay.appendChild(prevEl);
  overlay.appendChild(textEl);

  addLockButton();
  addDragListeners();
  applyLock();
  // 兜底：清掉历史副本可能残留的同 id 节点（如扩展重载前的旧实例），防止视觉上叠加
  document.getElementById('tmspeech-overlay')?.remove();
  document.body.appendChild(overlay);

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

function addDragListeners() {
  if (!overlay) return;

  overlay.onpointerdown = (e) => {
    if (_locked || e.target === lockBtn) return;
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

function destroy() {
  if (!overlay) return;
  const el = overlay;
  overlay = null; prevEl = null; textEl = null; lockBtn = null;
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
    overlay.style.background = 'rgba(0,0,0,0.25)';
    overlay.style.backdropFilter = 'blur(4px)';
    (overlay.style as any).webkitBackdropFilter = 'blur(4px)';
    overlay.style.boxShadow = '0 0 0 1px rgba(255,255,255,0.03)';
    overlay.style.border = '1px solid rgba(255,255,255,0.06)';
    overlay.style.cursor = 'move';
    lockBtn.style.opacity = '';
  }
  lockBtn.innerHTML = _locked ? UNLOCK_SVG : LOCK_SVG;
}

function setText(text: string) {
  if (!textEl) { _pendingText = text; return; }
  textEl.textContent = text;
}

function setOverlayText(prev: string, current: string) {
  const pe = prevEl, te = textEl;
  if (!pe || !te) return;
  const showPrev = _showPrev && prev;
  pe.textContent = prev;
  pe.style.display = showPrev ? '' : 'none';
  te.textContent = current;
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
      break;
    case 'SET_PREV_OPTS':
      _showPrev = msg.showPrev;
      _prevOpacity = (msg.prevOpacity ?? 35) / 100;
      if (prevEl) prevEl.style.opacity = String(_prevOpacity);
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
