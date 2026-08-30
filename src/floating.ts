import { getLang, tSync } from './i18n';

// 悬浮字幕窗：独立扩展页弹窗（chrome.windows.create type:'popup'），作为 system 音频
// 模式下的唯一显示端，tab 模式下也可选开。「置顶」按钮经 Document Picture-in-Picture
// （Chrome 116+，零新权限）把整个字幕板搬进系统级置顶的画中画窗口，盖在任何应用上方。
// 消息契约与 content.ts 页内字幕层一致（TEXT_CHANGED/OVERLAY_TEXT/SENTENCE_DONE/
// TRANSLATION/TRANSLATION_FINAL），由 background 的 FW_CT/FW_POP 扇出到达。

const $ = (id: string) => document.getElementById(id)!;
const barEl = $('bar');
const prevEl = $('prevLine') as HTMLDivElement;
const prevTransEl = $('prevTrans') as HTMLDivElement;
const curEl = $('curLine') as HTMLDivElement;
const transEl = $('transLine') as HTMLDivElement;
const levelFill = $('levelFill') as HTMLDivElement;
const btnPin = $('btnPin') as HTMLButtonElement;
const btnFontUp = $('btnFontUp') as HTMLButtonElement;
const btnFontDown = $('btnFontDown') as HTMLButtonElement;
const btnStop = $('btnStop') as HTMLButtonElement;
const pipHint = $('pipHint') as HTMLDivElement;

const FS_KEY = 'tmspeech_floating';
const FS_MIN = 18;
const FS_MAX = 72;

let lang = 'zh_CN';
let fontSize = 34;
let running = false;
// 句序号路由（与 content.ts 同款）：最近一次 SENTENCE_DONE 的 seq，当前句 seq = lastDoneSeq + 1
let lastDoneSeq = 0;
let _showPrev = true;
let _prevOpacity = 0.35;
let pipWin: Window | null = null;

// 与 background 的长连接：窗口关闭连接自动断开，bg 侧清 floatingPort
const port = chrome.runtime.connect({ name: 'floating' });
// 坑：MV3 的 SW 空闲会终止并断开所有端口——悬浮窗不能就此失聪。
// 断线后整页重载：init 重建连接，bg 的 floating 分支会补发 STATUS_CHANGED
// 并让 offscreen 重发当前句文本，UI 状态（字号/上一句/置顶）全部从 storage 还原。
// 3s 防抖避免 SW 反复挂起时陷入重载循环。
(window as any).__tmFloatLoaded = Date.now();
port.onDisconnect.addListener(() => {
  if (Date.now() - (window as any).__tmFloatLoaded > 3000) window.location.reload();
});

// ---- 字号 ----
function applyFontSize() {
  curEl.style.fontSize = fontSize + 'px';
  prevEl.style.fontSize = Math.round(fontSize * 0.58) + 'px';
  transEl.style.fontSize = Math.round(fontSize * 0.5) + 'px';
  prevTransEl.style.fontSize = Math.round(fontSize * 0.38) + 'px';
}

btnFontUp.onclick = () => {
  fontSize = Math.min(FS_MAX, fontSize + 2);
  applyFontSize();
  chrome.storage.local.set({ [FS_KEY]: { fontSize } });
};
btnFontDown.onclick = () => {
  fontSize = Math.max(FS_MIN, fontSize - 2);
  applyFontSize();
  chrome.storage.local.set({ [FS_KEY]: { fontSize } });
};

btnStop.onclick = () => {
  chrome.runtime.sendMessage({ type: 'STOP_RECOGNITION' }).catch(() => {});
};

// ---- 文案随语言刷新 ----
function applyLang() {
  const tr = (key: string) => tSync(lang, key);
  btnPin.title = pipWin ? tr('floatUnpin') : tr('floatPin');
  btnPin.setAttribute('aria-label', btnPin.title);
  btnFontUp.title = tr('floatFontUp');
  btnFontDown.title = tr('floatFontDown');
  btnStop.title = tr('btnStop');
  btnStop.setAttribute('aria-label', tr('btnStop'));
  document.title = tr('appTitle');
  if (!pipHint.hidden) pipHint.textContent = tr('floatPinnedHint');
}

// ---- Document Picture-in-Picture 置顶 ----
// 坑：requestWindow 必须由用户手势触发（按钮点击满足）；请求成功后把 #bar 整个搬进
// PiP 文档，元素引用持续有效，port 消息照常更新；PiP 窗口关闭（pagehide）搬回原窗口。
const dpi = (document as any).documentPictureInPicture;

function updatePinButton() {
  btnPin.classList.toggle('pinned', !!pipWin);
  applyLang();
}

function copyStylesTo(w: Window) {
  // 窗口内所有 <style> 克隆进 PiP 文档（含本页内联样式），保证字幕观感一致
  document.querySelectorAll('style').forEach((s) => {
    w.document.head.appendChild(s.cloneNode(true));
  });
}

function exitPip() {
  if (!pipWin) return;
  const w = pipWin;
  pipWin = null;
  w.removeEventListener('pagehide', onPipHide);
  try { w.close(); } catch { /* 已在关闭中 */ }
  document.body.insertBefore(barEl, pipHint);
  pipHint.hidden = true;
  updatePinButton();
}

function onPipHide() { exitPip(); }

btnPin.onclick = async () => {
  if (pipWin) { exitPip(); return; }
  if (!dpi) return;
  try {
    const w: Window = await dpi.requestWindow({
      width: Math.max(360, Math.round(window.outerWidth)),
      height: Math.max(120, Math.round(window.outerHeight)),
    });
    copyStylesTo(w);
    pipWin = w;
    w.document.body.append(barEl);
    // 本窗口留下占位提示，避免"字幕凭空消失"的困惑
    pipHint.hidden = false;
    pipHint.textContent = tSync(lang, 'floatPinnedHint');
    w.addEventListener('pagehide', onPipHide);
    updatePinButton();
  } catch (e) {
    console.log('[TM Floating] PiP 置顶失败:', e);
  }
};

if (!dpi) {
  // 老浏览器无 Document PiP：隐藏置顶按钮，窗口仍是可拖动的普通悬浮窗
  btnPin.style.display = 'none';
}

// ---- 消息处理（语义与 content.ts 页内字幕层对齐）----
function setError(text: string) {
  curEl.classList.add('error');
  curEl.textContent = text;
}

function clearError() {
  curEl.classList.remove('error');
}

port.onMessage.addListener((msg: any) => {
  switch (msg.type) {
    case 'TEXT_CHANGED':
      clearError();
      curEl.textContent = msg.text;
      break;
    case 'OVERLAY_TEXT': {
      clearError();
      const show = _showPrev && !!msg.prev;
      prevEl.style.display = show ? '' : 'none';
      prevTransEl.style.display = show && prevTransEl.textContent ? '' : 'none';
      prevEl.textContent = msg.prev || '';
      curEl.textContent = msg.current || '';
      break;
    }
    case 'SENTENCE_DONE': {
      // 句序号推进（缺省按本地计数兜底），随后 TRANSLATION 按序号路由到当前/上一句行
      const seq = Number(msg.seq) || 0;
      lastDoneSeq = seq > 0 ? seq : lastDoneSeq + 1;
      // 换句：当前句的流式译文立即移交"上一句"槽，不等定稿翻译排队
      if (transEl.textContent) {
        prevTransEl.textContent = transEl.textContent;
        prevTransEl.style.opacity = String(_prevOpacity);
        prevTransEl.style.display = _showPrev ? '' : 'none';
      }
      transEl.textContent = '';
      transEl.style.display = 'none';
      break;
    }
    case 'TRANSLATION': {
      // 流式译文按句序号路由：当前句进 transLine；上一句迟到流式结果补进 prevTrans
      if (msg.text) {
        const s = Number(msg.seq) || 0;
        if (s === lastDoneSeq + 1) {
          transEl.textContent = msg.text;
          transEl.style.display = '';
        } else if (s === lastDoneSeq && s > 0) {
          prevTransEl.textContent = msg.text;
          prevTransEl.style.opacity = String(_prevOpacity);
          prevTransEl.style.display = _showPrev ? '' : 'none';
        }
      }
      break;
    }
    case 'TRANSLATION_FINAL': {
      // 定稿译文总属于"上一句"（seq === lastDoneSeq）
      if (msg.text) {
        const s = Number(msg.seq) || 0;
        if (s === lastDoneSeq && s > 0) {
          prevTransEl.textContent = msg.text;
          prevTransEl.style.opacity = String(_prevOpacity);
          prevTransEl.style.display = _showPrev ? '' : 'none';
          transEl.textContent = '';
          transEl.style.display = 'none';
        }
      }
      break;
    }
    case 'LEVEL':
      levelFill.style.width = (Math.max(0, Math.min(1, Number(msg.v) || 0)) * 100).toFixed(1) + '%';
      break;
    case 'STATUS_CHANGED':
      running = msg.status === 'Running';
      btnStop.disabled = !running;
      break;
    case 'ERROR':
      setError(String(msg.message ?? ''));
      break;
  }
});

// ---- 初始化：语言 / 字号 / 上一句偏好 / 初始文案 ----
(async () => {
  lang = await getLang();
  try {
    const fr = await chrome.storage.local.get(FS_KEY);
    const f = fr[FS_KEY] as any;
    if (f && typeof f.fontSize === 'number') fontSize = Math.min(FS_MAX, Math.max(FS_MIN, f.fontSize));
  } catch { /* 读不到走默认字号 */ }
  try {
    const pr = await chrome.storage.local.get('tmspeech_prefs');
    const prefs = (pr['tmspeech_prefs'] as any) || {};
    _showPrev = prefs.showPrev !== false;
    _prevOpacity = (prefs.prevOpacity ?? 35) / 100;
  } catch { /* 读不到走默认透明度 */ }
  applyFontSize();
  applyLang();
  curEl.textContent = tSync(lang, 'waiting');
})();
