import { Overlay } from './overlay';
console.log('[TM Content] loaded');
// 坑：background 可能在同一页面重复注入本脚本（启动重试、导航重注入竞态）。
// 这里刻意不用 window 标记拦截重复副本——扩展重载后旧标记会残留，把新副本误杀，
// 导致该页字幕失效到手动刷新为止。正确策略是"后来者接管"：
// Overlay.create() 会按 DOM id 移除旧节点，消息处理全部幂等，多副本并存也只显示一层字幕。

// 叠层实现与悬浮字幕窗共用 src/overlay.ts（唯一事实源），本文件只负责接线：
// 挂载进页面（含全屏迁移），接收 background 的 tabs.sendMessage 消息。
const overlayHost = new Overlay({ trackFullscreen: true });

chrome.runtime.onMessage.addListener((msg) => overlayHost.handle(msg));

// 监听扩展断开，自动隐藏字幕
(function monitorExtension() {
  const port = chrome.runtime.connect({ name: 'content' });
  port.onDisconnect.addListener(() => overlayHost.destroy());
})();