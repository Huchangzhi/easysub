// 面板页 ↔ 字幕浮窗 的跨窗口消息总线（纯 Web 版专用）。
//
// 主通道用 **BroadcastChannel**，而不是 window.postMessage/opener：
//   - opener 关系不可靠：浏览器对 window.open 的 noopener 处理、以及某些环境下浮窗
//     被当作独立标签页打开时，window.opener 为 null，消息直接石沉大海（实测如此）；
//   - BroadcastChannel 与窗口拓扑无关，同源即可通，双方互发互收，窗口关闭自动失效。
// 兜底通道保留 opener 的 postMessage：极老浏览器没有 BroadcastChannel 时仍能工作。
//
// 消息形态：{ from: 'panel' | 'subtitle', msg: any }，接收端按 from 过滤掉自己发的。
// 心跳：浮窗每 2 秒广播一次 hello，面板收到就记住"对端已就绪"并回 ack；
// 浮窗收到 ack 后发 ready，面板据此重推一遍偏好与状态（面板刷新后自愈的关键）。

export type ChannelRole = 'panel' | 'subtitle';

const HELLO_INTERVAL_MS = 2000;
const CHANNEL_NAME = 'easysub-web';

type MsgHandler = (msg: any) => void;

let role: ChannelRole = 'panel';
let handler: MsgHandler = () => {};
let onPeerReady: (() => void) | null = null;
let bus: BroadcastChannel | null = null;
let peerSeen = false;
let helloTimer: any = null;

// 兜底：极老环境无 BroadcastChannel 时用 opener 的 postMessage。
// targetOrigin 用 '*'：file:// 下 origin 是 "null"，用它做匹配会一条都发不出去；
// 消息体只有字幕/状态，不含敏感数据，可接受。
function postViaOpener(msg: any) {
  const w = role === 'subtitle' ? (window.opener as Window | null) : null;
  if (!w) return;
  try { w.postMessage({ from: role, msg }, '*'); } catch { /* 已关闭 */ }
}

export function sendToPeer(msg: any): boolean {
  const payload = { from: role, msg };
  if (bus) {
    try { bus.postMessage(payload); return true; } catch { /* 通道已关闭，退回 opener */ }
  }
  postViaOpener(msg);
  return true;
}

export function hasPeer(): boolean { return peerSeen; }

export function initChannel(r: ChannelRole, onMessage: MsgHandler, onPeerReconnected?: () => void) {
  role = r;
  handler = onMessage;
  onPeerReady = onPeerReconnected ?? null;

  const dispatch = (msg: any) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === '__hello') {
      peerSeen = true;
      // 收到心跳即确认对端在：回 ack，让对端发 ready 触发一次状态补齐
      sendToPeer({ type: '__ack' });
      return;
    }
    if (msg.type === '__ack') {
      peerSeen = true;
      sendToPeer({ type: '__ready' });
      return;
    }
    if (msg.type === '__ready') {
      peerSeen = true;
      onPeerReady?.();
      return;
    }
    try { handler(msg); } catch (err) { console.error('[EasySub] 跨窗口消息处理异常', err); }
  };

  if (typeof BroadcastChannel !== 'undefined') {
    bus = new BroadcastChannel(CHANNEL_NAME);
    bus.addEventListener('message', (e: MessageEvent) => {
      const d = e.data;
      // 过滤自己发的：BroadcastChannel 也回送给发送方
      if (!d || d.from === role) return;
      dispatch(d.msg);
    });
  }

  // 兜底/补充：opener 直投（无 BroadcastChannel 时是唯一通道；
  // 有时两者都可用，重复消息由各处理器的幂等性吸收）
  window.addEventListener('message', (e: MessageEvent) => {
    const d = e.data;
    if (!d || d.from === role || !('msg' in d)) return;
    dispatch(d.msg);
  });

  if (role === 'subtitle') {
    // 心跳：面板刷新后靠它重新确认对端存在，并让面板重推偏好。
    // 浮窗关闭时先喊一声，面板据此清掉窗口引用（避免"僵尸浮窗"误判）。
    const beat = () => sendToPeer({ type: '__hello' });
    beat();
    helloTimer = setInterval(beat, HELLO_INTERVAL_MS);
    window.addEventListener('pagehide', () => {
      sendToPeer({ type: '__subtitle_closed' });
      stopChannel();
    });
  }
}

export function stopChannel() {
  if (helloTimer) { clearInterval(helloTimer); helloTimer = null; }
  try { bus?.close(); } catch { /* 已关闭 */ }
  bus = null;
}

// 面板侧：window.open 之后只能确认"发起过"，真正的对端确认以首次心跳为准。
// 这里保留一个显式登记入口供将来扩展（如需要立刻判定窗口是否被拦截）。
export function notePeerWindowOpened(win: Window | null) {
  if (win) peerSeen = peerSeen || false;
}
