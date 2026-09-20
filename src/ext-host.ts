// 浏览器后端抽象：Chrome 专属能力收敛成跨浏览器同一调用面。
//  - offscreen 文档生命周期：Chrome 用 chrome.offscreen API；Firefox（无此 API）用一个
//    可见的小弹窗（browser.windows.create）承载同一份 offscreen.html。必须是可见页面：
//    系统音频捕获 getDisplayMedia 要求"页面可见 + 用户点击"的真实手势（FF 不随扩展
//    消息传递 transient activation，bug 1753502），隐藏 iframe 永远无法通过该检查。
//  - 标签页音频：仅 Chrome（getMediaStreamId 可指定标签页）；Firefox 平台无 tab 音频
//    捕获 API（bug 1541425，mediaSource:'tab' 已移除），只保留系统音频模式，由可见
//    窗口内用户点击触发 getDisplayMedia。
// Firefox 与 Chrome 共用同一份 background.js / offscreen.js，全部差异收敛在本文件。

// 坑：不用 chrome.offscreen 做探测——Chrome 的 offscreen 文档上下文可能不暴露该模块，
// 在 offscreen.html 里执行就会把 Chrome 误判成 Firefox。UA 检测在各上下文（SW/页面/
// popup/offscreen 文档）行为一致，Firefox（桌面/安卓）UA 均含 'Firefox'，Chrome 不含。
export const isFirefox = typeof chrome !== 'undefined' && /Firefox/i.test(navigator.userAgent);

const OFFSCREEN_URL = 'offscreen.html';
const OFFSCREEN_REASONS = ['USER_MEDIA', 'DISPLAY_MEDIA'];
const OFFSCREEN_JUSTIFICATION = 'Speech recognition audio processing';
// 可见捕获窗口尺寸：只需放得下「选择音频来源」按钮
const FF_WIN_WIDTH = 380;
const FF_WIN_HEIGHT = 300;

let ffWindowId: number | null = null;

// 用户可能手动关掉捕获窗口：及时清 id，下次 ensure 才能重建
chrome.windows?.onRemoved.addListener((wid) => {
  if (ffWindowId === wid) ffWindowId = null;
});

export async function ensureOffscreenHost(): Promise<void> {
  if (!isFirefox) {
    const exists = await chrome.offscreen.hasDocument();
    if (exists) return;
    await chrome.offscreen.createDocument({ url: OFFSCREEN_URL, reasons: OFFSCREEN_REASONS as any, justification: OFFSCREEN_JUSTIFICATION });
    return;
  }
  if (ffWindowId != null) {
    try { await chrome.windows.get(ffWindowId); return; } catch { ffWindowId = null; }
  }
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(OFFSCREEN_URL),
    type: 'popup',
    width: FF_WIN_WIDTH,
    height: FF_WIN_HEIGHT,
    focused: true,
  });
  ffWindowId = win?.id ?? null;
}

export async function hasOffscreenHost(): Promise<boolean> {
  if (!isFirefox) return chrome.offscreen.hasDocument();
  if (ffWindowId == null) return false;
  try { await chrome.windows.get(ffWindowId); return true; } catch { ffWindowId = null; return false; }
}

export async function closeOffscreenHost(): Promise<void> {
  if (!isFirefox) {
    await chrome.offscreen.closeDocument();
    return;
  }
  if (ffWindowId != null) {
    const id = ffWindowId;
    ffWindowId = null;
    try { await chrome.windows.remove(id); } catch { /* 已被用户手动关闭 */ }
  }
}