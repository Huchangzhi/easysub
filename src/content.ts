import { tSync } from './i18n';
console.log('[TM Content] loaded');

let overlay: HTMLDivElement | null = null;
let textEl: HTMLDivElement | null = null;
let lockBtn: HTMLButtonElement | null = null;
let _locked = false;
let animFrame: number | null = null;
let dragState: {
  baseLeft: number; baseTop: number;
  startX: number; startY: number;
  samples: { x: number; y: number; t: number }[];
} | null = null;

const STORAGE_KEY = 'tmspeech_overlay';
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const LOCK_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 1 1 8 0v4"/></svg>';
const UNLOCK_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8.5 11V7a3.5 3.5 0 0 1 6.5-2"/></svg>';

function cancelAnim() {
  if (animFrame !== null) { cancelAnimationFrame(animFrame); animFrame = null; }
}

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
  s.willChange = 'transform';

  if (!REDUCED) {
    s.opacity = '0';
    s.transform = 'scale(0.96) translate(-50%, -50%)';
    s.transition = 'opacity 200ms cubic-bezier(0.23,1,0.32,1), transform 200ms cubic-bezier(0.23,1,0.32,1)';
  } else {
    s.transform = 'translate(-50%, -50%)';
  }

  chrome.storage.local.get('tmspeech_locked').then(r => {
    if (r.tmspeech_locked) { _locked = true; applyLock(); }
  });

  textEl = document.createElement('div');
  chrome.storage.local.get(['tmspeech_prefs', 'tmspeech_lang']).then(r => {
    const prefs = (r['tmspeech_prefs'] as any) || {};
    const lang = (r['tmspeech_lang'] as string) || 'zh_CN';
    const fs = prefs.fontSize || 36;
    if (textEl) {
      textEl.style.cssText = `color:#fff;font-size:${fs}px;font-weight:600;line-height:1.4;text-shadow:0 1px 10px rgba(0,0,0,0.8);word-break:break-word;`;
      if (!REDUCED) textEl.style.transition = 'opacity 120ms cubic-bezier(0.23,1,0.32,1)';
      textEl.textContent = tSync(lang, 'loadingModel');
    }
  });
  overlay.appendChild(textEl);

  addLockButton();
  addDragListeners();
  applyLock();
  document.body.appendChild(overlay);

  if (!REDUCED) {
    requestAnimationFrame(() => {
      if (overlay) { overlay.style.opacity = '1'; overlay.style.transform = 'scale(1) translate(-50%, -50%)'; }
    });
  }

  chrome.storage.local.get(STORAGE_KEY).then(stored => {
    if (!overlay) return;
    const d = (stored[STORAGE_KEY] as any) || {};
    if (d.left) overlay.style.left = d.left;
    if (d.top) overlay.style.top = d.top;
    if (d.width) overlay.style.width = d.width;
    if (d.height) overlay.style.height = d.height;
    if (d.left || d.top) {
      overlay.style.transform = 'none';
      overlay.style.willChange = '';
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
    'transition:opacity 200ms cubic-bezier(0.23,1,0.32,1), background 120ms cubic-bezier(0.23,1,0.32,1);',
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
    cancelAnim();
    const rect = overlay!.getBoundingClientRect();
    dragState = {
      baseLeft: rect.left,
      baseTop: rect.top,
      startX: e.clientX,
      startY: e.clientY,
      samples: [{ x: e.clientX, y: e.clientY, t: performance.now() }],
    };
    overlay!.setPointerCapture(e.pointerId);
    overlay!.style.willChange = 'transform';
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

    dragState.samples.push({ x: e.clientX, y: e.clientY, t: performance.now() });
    if (dragState.samples.length > 5) dragState.samples.shift();
  };

  overlay.onpointerup = (e) => {
    if (!dragState) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;

    let vx = 0, vy = 0;
    if (dragState.samples.length >= 2) {
      const first = dragState.samples[0];
      const last = dragState.samples[dragState.samples.length - 1];
      const dt = (last.t - first.t) / 1000;
      if (dt > 0.001) { vx = (last.x - first.x) / dt; vy = (last.y - first.y) / dt; }
    }

    const targetLeft = dragState.baseLeft + dx;
    const targetTop = dragState.baseTop + dy;
    overlay!.style.left = targetLeft + 'px';
    overlay!.style.top = targetTop + 'px';
    overlay!.style.transform = 'none';
    overlay!.style.willChange = '';

    const speed = Math.sqrt(vx * vx + vy * vy);
    if (!REDUCED && speed > 80) {
      const ow = overlay!.offsetWidth;
      const oh = overlay!.offsetHeight;
      let projL = targetLeft + vx * 0.12;
      let projT = targetTop + vy * 0.12;
      const margin = 10;
      const maxL = window.innerWidth - ow - margin;
      const maxT = window.innerHeight - oh - margin;
      projL = Math.max(margin, Math.min(projL, maxL));
      projT = Math.max(margin, Math.min(projT, maxT));

      let pL = targetLeft, pT = targetTop;
      let vL = vx, vT = vy;
      const k = 0.008, f = 0.78;

      function settle() {
        const dL = projL - pL, dT = projT - pT;
        vL += dL * k; vT += dT * k;
        vL *= f; vT *= f;
        pL += vL; pT += vT;
        overlay!.style.left = pL + 'px';
        overlay!.style.top = pT + 'px';

        if (Math.abs(vL) < 0.1 && Math.abs(vT) < 0.1 && Math.abs(dL) < 0.5 && Math.abs(dT) < 0.5) {
          overlay!.style.left = projL + 'px';
          overlay!.style.top = projT + 'px';
          animFrame = null;
          scheduleSave();
          return;
        }
        animFrame = requestAnimationFrame(settle);
      }
      animFrame = requestAnimationFrame(settle);
    } else {
      scheduleSave();
    }

    dragState = null;
  };

  overlay.onpointercancel = () => { dragState = null; };
}

function destroy() {
  if (!overlay) return;
  cancelAnim();
  const el = overlay;
  overlay = null; textEl = null; lockBtn = null;
  if (saveTimer) clearTimeout(saveTimer);
  if (!REDUCED) {
    el.style.transition = 'opacity 150ms ease-out, transform 150ms ease-out';
    el.style.opacity = '0';
    el.style.transform = 'scale(0.96)';
    setTimeout(() => el.remove(), 150);
  } else {
    el.remove();
  }
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
  if (!textEl) return;
  if (!REDUCED) {
    textEl.style.opacity = '0';
    setTimeout(() => {
      if (textEl) { textEl.textContent = text; textEl.style.opacity = '1'; }
    }, 60);
  } else {
    textEl.textContent = text;
  }
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
      if (textEl) { textEl.style.fontSize = msg.fontSize + 'px'; scheduleSave(); }
      break;
    case 'RESET_OVERLAY_POSITION':
      chrome.storage.local.remove(STORAGE_KEY);
      if (overlay) {
        overlay.style.left = '50%';
        overlay.style.top = '50%';
        overlay.style.transform = 'translate(-50%, -50%)';
        overlay.style.width = '';
        overlay.style.height = '';
        overlay.style.willChange = '';
        if (!REDUCED) {
          overlay.style.transition = 'left 400ms cubic-bezier(0.23,1,0.32,1), top 400ms cubic-bezier(0.23,1,0.32,1), transform 400ms cubic-bezier(0.23,1,0.32,1)';
          requestAnimationFrame(() => {
            if (overlay) { overlay.style.transition = ''; }
          });
        }
      }
      break;
  }
});
