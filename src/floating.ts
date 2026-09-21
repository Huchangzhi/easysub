import { getLang, tSync } from './i18n';
import { Overlay } from './overlay';

// 悬浮字幕窗：独立扩展页弹窗（chrome.windows.create type:'popup'），system 音频模式下
// 的唯一显示端（tab 模式自动关闭，字幕走页内叠层）。主体字幕与页内注入共用
// overlay.ts 同一份实现（fill 模式铺满窗口）——观感、交互、设置同步天然一致。
// 「置顶」经 Document Picture-in-Picture（Chrome 116+，零新权限）把整窗搬进
// 系统级置顶的画中画窗口，盖在任何应用上方。

const $ = (id: string) => document.getElementById(id)!;
const pipRoot = $('pipRoot');
const btnPin = $('btnPin') as HTMLButtonElement;
const btnFontUp = $('btnFontUp') as HTMLButtonElement;
const btnFontDown = $('btnFontDown') as HTMLButtonElement;
const btnStop = $('btnStop') as HTMLButtonElement;

const FS_MIN = 18;
const FS_MAX = 72;

let lang = 'zh_CN';
let fontSize = 34;
let running = false;
let pipWin: Window | null = null;
let autoPinned = false;

// 与 background 的长连接：窗口关闭连接自动断开，bg 侧清 floatingPort
let port = chrome.runtime.connect({ name: 'floating' });
// 坑：MV3 的 SW 空闲会终止并断开所有端口——悬浮窗不能就此失聪。
// 断线后整页重载：init 重建连接，bg 的 floating 分支会补发 STATUS_CHANGED
// 并让 offscreen 重发当前句文本，UI 状态从 storage 还原。3s 防抖避免重载循环。
(window as any).__tmFloatLoaded = Date.now();
port.onDisconnect.addListener(() => {
  if (Date.now() - (window as any).__tmFloatLoaded > 3000) window.location.reload();
});

// 共用叠层（与页内 content.ts 完全一致）；fill 模式铺满整个窗口/画中画窗口，
// 缩放窗口即缩放字幕区域；挂进 pipRoot 以便 PiP 整体搬移
const overlayHost = new Overlay({
  storageKey: 'tmspeech_overlay_floating',
  mountTarget: () => pipRoot,
  trackFullscreen: false,
  fill: true,
});

// ---- Document Picture-in-Picture 置顶 ----
// 坑：Document PiP 入口按规范 [Exposed=Window] 只挂在 window 上
// （document.documentPictureInPicture 恒为 undefined）——此前从 document 取导致
// 置顶按钮被隐藏、置顶完全失效。这里 window 优先，document 仅作兜底兼容。
const dpi = (window as any).documentPictureInPicture || (document as any).documentPictureInPicture;

function copyStylesTo(w: Window) {
  // 窗口内所有 <style> 克隆进 PiP 文档（含本页内联样式），保证字幕观感一致
  document.querySelectorAll('style').forEach((s) => {
    w.document.head.appendChild(s.cloneNode(true));
  });
}

function updatePinButton() {
  btnPin.classList.toggle('pinned', !!pipWin);
  applyLang();
}

// 把画中画搬回本窗口并恢复（取消置顶）。仅由工具条「置顶/取消置顶」按钮触发；
// 用户直接关掉画中画窗口走 onPipHide（=停止识别），不会走到这里。
function exitPip() {
  if (!pipWin) return;
  const w = pipWin;
  pipWin = null;
  w.removeEventListener('pagehide', onPipHide);
  try { w.close(); } catch { /* 已在关闭中 */ }
  document.body.appendChild(pipRoot);
  updatePinButton();
  // 恢复原窗口到前台（置顶时它被最小化藏进任务栏）
  chrome.windows.getCurrent().then((win) => {
    if (win?.id != null) chrome.windows.update(win.id, { state: 'normal', focused: true });
  }).catch(() => {});
}

// 用户直接关掉画中画窗口：悬浮窗是唯一显示端兼控制器，关闭即结束识别。
// 通知 bg 走 cleanupAll（关 offscreen、停采集、连本窗口一起移除）。
function onPipHide() {
  pipWin = null;
  try { chrome.runtime.sendMessage({ type: 'STOP_RECOGNITION' }).catch(() => {}); } catch {}
}

async function pinToPip() {
  // requestWindow 必须由用户手势触发：按钮点击满足；无手势会直接 NotAllowedError
  const w: Window = await dpi.requestWindow({
    width: Math.max(360, Math.round(window.outerWidth)),
    height: Math.max(120, Math.round(window.outerHeight)),
  });
  copyStylesTo(w);
  pipWin = w;
  w.document.body.append(pipRoot);
  w.addEventListener('pagehide', onPipHide);
  updatePinButton();
  // 坑：画中画窗口不能比 opener 活得久——原窗口必须存活，无法"关掉"。
  // 置顶成功后把它最小化藏进任务栏，桌面上就只剩置顶的字幕画中画窗口；
  // 若用户此后再从任务栏恢复/关闭原窗，bg 的 windows.onRemoved 仍会兜底停识别。
  try {
    const win = await chrome.windows.getCurrent();
    if (win?.id != null) await chrome.windows.update(win.id, { state: 'minimized' });
  } catch { /* 最小化失败不影响置顶使用 */ }
}

// 默认置顶：requestWindow 受浏览器安全约束必须用户手势触发、无法在加载时自动调用，
// 因此挂首次点击自动置顶——任意点击窗口即进画中画，无需找图钉按钮。
// 工具条与叠层内按钮（锁定/回看）不触发自动置顶，避免调字号时误进画中画。
function tryAutoPin(e: Event) {
  if (pipWin || !dpi || autoPinned) return;
  const t = e.target as Element | null;
  if (t?.closest?.('.toolbar')) return;
  if (t?.closest?.('button')) return;
  autoPinned = true;
  window.removeEventListener('click', tryAutoPin, true);
  pinToPip().catch((err) => {
    console.log('[TM Floating] 自动置顶失败:', err);
    autoPinned = false;
  });
}
window.addEventListener('click', tryAutoPin, true);

btnPin.onclick = () => {
  if (pipWin) { exitPip(); return; }
  if (!dpi) return;
  pinToPip().catch((e) => console.log('[TM Floating] 置顶失败:', e));
};

if (!dpi) {
  // 老浏览器无 Document PiP：隐藏置顶按钮，窗口仍是可拖动的普通悬浮窗
  btnPin.style.display = 'none';
}

// ---- 字号快捷调节（同步到 popup 偏好与页内叠层）----
function persistFontSize() {
  overlayHost.handle({ type: 'SET_FONT_SIZE', fontSize });
  chrome.storage.local.get('tmspeech_prefs').then(r => {
    const prefs = (r['tmspeech_prefs'] as any) || {};
    chrome.storage.local.set({ tmspeech_prefs: { ...prefs, fontSize } });
  });
  chrome.runtime.sendMessage({ type: 'SET_FONT_SIZE', fontSize }).catch(() => {});
}

btnFontUp.onclick = () => {
  fontSize = Math.min(FS_MAX, fontSize + 2);
  persistFontSize();
};
btnFontDown.onclick = () => {
  fontSize = Math.max(FS_MIN, fontSize - 2);
  persistFontSize();
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
}

// ---- 麦克风采集宿主（mic 音源）----
// Chrome 不允许 offscreen 文档做 getUserMedia 麦克风采集（直接 NotAllowedError），
// 权限气泡也只能出现在可见窗口——所以 mic 模式下本窗口兼任采集端：PCM 以 16k 单声道
// 经 audio-worklet-processor.js（与 offscreen 本地采集同一协议）出块，交 bg 转发给
// offscreen 的识别管道。首次使用时的麦克风授权弹窗就挂在本窗口上。
// 不指定 deviceId：交给 Chrome 授权弹窗选择设备（并记住），与不下拉设备的取舍一致。
let micStream: MediaStream | null = null;
let micCtx: AudioContext | null = null;
let micWorklet: AudioWorkletNode | null = null;
let micFlushTimer: any = null;
let micActive = false;

function micStop() {
  micActive = false;
  if (micFlushTimer) { clearInterval(micFlushTimer); micFlushTimer = null; }
  if (micWorklet) { try { micWorklet.port.onmessage = null; micWorklet.disconnect(); } catch { /* 已断开 */ } micWorklet = null; }
  if (micCtx) { micCtx.close().catch(() => {}); micCtx = null; }
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
}

function micFail(name: string, error: string) {
  try { port.postMessage({ type: 'MIC_RESULT', ok: false, name, error }); } catch { /* 端口已断，bg 侧自会停会话 */ }
}

async function micStart() {
  // 重复指令（启动直发 + 端口重连补发双入口）幂等跳过：已在采就不重开
  if (micActive) return;
  micStop();
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e: any) {
    micFail(e?.name || '', e?.message || String(e));
    return;
  }
  try {
    micCtx = new AudioContext({ sampleRate: 16000 }); // 强制 16k：下游管道直吃，零重采样
    const src = micCtx.createMediaStreamSource(micStream);
    await micCtx.audioWorklet.addModule(chrome.runtime.getURL('audio-worklet-processor.js'));
    const node = new AudioWorkletNode(micCtx, 'audio-buffer');
    micWorklet = node;
    src.connect(node);
    node.port.onmessage = (ev: MessageEvent) => {
      if (!ev.data?.audio) return;
      // 坑：chrome.runtime.Port 的 postMessage 走 JSON 结构化克隆，ArrayBuffer 会被
      // 序列化成空对象（byteLength 丢失、字节内容全无），PCM 静默变垃圾。
      // 必须转成普通数组传（Float32 样本经 JSON 是保值的），接收端再还原 Float32Array。
      const f32 = new Float32Array(ev.data.audio);
      if (!f32.length) return;
      try {
        port.postMessage({ type: 'MIC_CHUNK', audio: Array.from(f32), sampleRate: ev.data.sampleRate });
      } catch { /* 端口瞬断（窗口正在关闭），下一块继续 */ }
    };
    // 与 offscreen 本地采集同一节拍：60ms 推一次 flush，让 worklet 吐块
    micFlushTimer = setInterval(() => { try { node.port.postMessage('flush'); } catch { /* 节点已销毁 */ } }, 60);
    micActive = true;
    // 设备中途被拔：轨道 ended 即断粮，报 bg 结束会话（无音频的 Running 是幽灵态）
    micStream.getAudioTracks()[0]?.addEventListener('ended', () => {
      if (!micActive) return;
      micStop();
      micFail('TrackEnded', '麦克风设备已断开');
    });
  } catch (e: any) {
    micStop();
    micFail(e?.name || '', e?.message || String(e));
  }
}

// 窗口关闭/重载即停采集：轨道随之释放，避免麦克风指示灯常亮
window.addEventListener('pagehide', micStop);

// ---- 消息处理：显示类交给共享叠层（协议与页内 content.ts 完全一致），
// 状态类由本壳自用 ----
port.onMessage.addListener((msg: any) => {
  if (msg?.type === 'STATUS_CHANGED') {
    running = msg.status === 'Running';
    btnStop.disabled = !running;
  }
  if (msg?.type === 'MIC_CAPTURE_START') { void micStart(); return; }
  if (msg?.type === 'MIC_CAPTURE_STOP') { micStop(); return; }
  overlayHost.handle(msg);
});

// ---- 初始化 ----
(async () => {
  lang = await getLang();
  try {
    const pr = await chrome.storage.local.get('tmspeech_prefs');
    const prefs = (pr['tmspeech_prefs'] as any) || {};
    if (typeof prefs.fontSize === 'number') fontSize = Math.min(FS_MAX, Math.max(FS_MIN, prefs.fontSize));
  } catch { /* 读不到走默认字号 */ }
  applyLang();
  // 悬浮窗仅在识别会话中存在（bg 按音源自动开合），落地即建叠层
  overlayHost.create();
  // 叠层与工具条同为最高 z-index、靠 DOM 顺序分胜负——把工具条挪到叠层之后，确保浮于其上
  pipRoot.appendChild(document.querySelector('.toolbar') as HTMLElement);
})();