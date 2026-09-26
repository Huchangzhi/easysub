// 纯 Web 版字幕浮窗宿主。
//
// 与扩展的悬浮字幕窗（floating.ts）共用同一份浮窗外壳 SubtitleShell + overlay.ts，
// 差别只有"消息从哪来"：这里走 window.postMessage 通道（channel.ts），
// 面板页是引擎宿主，浮窗只负责显示 + 工具条（停止/字号/置顶）。
import { SubtitleShell } from '../subtitle-shell';
import { storage, sendToHost } from '../platform';
import { initChannel, sendToPeer } from './channel';

const shell = new SubtitleShell({
  storageKey: 'tmspeech_overlay_web_floating',
  onStop: () => {
    // 工具条停止按钮：面板页是引擎宿主，停会话的消息发给它
    sendToPeer({ type: 'STOP_RECOGNITION' });
  },
  onFontSize: (size) => {
    // 字号同步：写偏好（面板下次启动会带上）+ 通知面板即时生效
    sendToPeer({ type: 'SET_FONT_SIZE', fontSize: size });
  },
  onPipClosed: () => {
    // 用户直接关掉画中画窗口：与扩展语义一致——浮窗是唯一显示端，关闭即停识别，
    // 否则识别继续跑却看不到任何字幕（用户会以为卡死）。
    sendToPeer({ type: 'STOP_RECOGNITION' });
  },
  onTeardown: () => {
    // 浮窗真的被关闭：通知面板（面板据此清掉窗口引用并可重新打开）
    sendToPeer({ type: '__subtitle_closed' });
  },
  onLockChanged: (locked) => {
    // 浮窗里点了锁定按钮：面板要同步勾选态。
    // 消息名沿用扩展的 LOCK_CHANGED_FROM_CONTENT，面板/宿主两侧因此无需区分宿主。
    sendToPeer({ type: 'LOCK_CHANGED_FROM_CONTENT', locked });
  },
});

// —— 通道：来自面板的消息（显示类 / 状态类 / 偏好类）——
initChannel('subtitle', (msg) => {
  if (msg?.type === 'STOP_RECOGNITION') {
    // 面板侧已自行收敛会话，这里只需把显示端也归位（按钮禁用）
    shell.handle({ type: 'STATUS_CHANGED', status: 'Stopped' });
    return;
  }
  if (msg?.type === '__panel_unload') {
    // 面板页关掉/刷新了：引擎随之消失，字幕不可能再来——停止按钮置灰并提示
    shell.handle({ type: 'STATUS_CHANGED', status: 'Stopped' });
    return;
  }
  shell.handle(msg);
}, () => {
  // 面板心跳回来（含面板刷新后的重新握手）：请求一次状态与偏好补齐
  sendToPeer({ type: '__subtitle_ready' });
});

// 面板侧收到 __subtitle_ready 会回推偏好与状态；这里不做额外请求。
// 浮窗被关闭前最后再喊一声，让面板能及时清引用。
window.addEventListener('pagehide', () => {
  sendToPeer({ type: '__subtitle_closed' });
});

shell.init();
// 调试入口：控制台可查置顶状态
(window as any).__easysubSubtitle = { shell, isPinned: () => shell.isPinned() };
// 偏好由面板在握手后推来；这里先按 storage 里已有的值渲染一遍，避免开窗瞬间空白
void storage.get('tmspeech_prefs').then((r) => {
  const prefs = (r['tmspeech_prefs'] as any) || {};
  shell.handle({ type: 'PREFS_PATCH', ...prefs });
});
