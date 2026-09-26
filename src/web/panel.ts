// 纯 Web 版面板入口：共享控制面板（src/panel.ts）+ 本文件的宿主接线。
//
// 宿主侧要做的四件事：
//   ① 起 host.ts（相当于扩展的 background + offscreen 合体）；
//   ② 在用户手势内预取屏幕共享音频流（getDisplayMedia 要求瞬时激活）；
//   ③ 管理字幕浮窗（window.open，对应扩展自动弹出的悬浮字幕窗）；
//   ④ 把音源收成"系统音频 / 麦克风"两态、把提示语换成 Web 版说法。
import { mountPanel, requireCrossOriginIsolation, setPreloadGate, isAsrModelReady, type PanelHostHooks } from '../panel';
import { tSync } from '../i18n';
import { resolveUrl } from '../platform';
import {
  installWebHost, preAcquireAudio, getSessionStatus, preloadEngine,
  primeSubtitlePrefs, handleFromSubtitle, onSubtitleWindowRef, setSubtitleWindowRef,
} from './host';
import { hasBundledResource } from '../platform';
import { ASR_DATA_PATH, ASR_DB_KEY } from '../asr-engine';
import { getModelFile } from '../model-db';
import { initChannel, sendToPeer, hasPeer, stopChannel } from './channel';

// 纯 Web 版**必须**跨源隔离：sherpa-onnx 的 wasm 是 pthreads 构建（共享内存 + worker），
// 没有 crossOriginIsolated 时连初始化都会抛 DataCloneError。扩展侧豁免此限制。
requireCrossOriginIsolation(true);

// wasm 预热门：只有模型已就绪（包内自带或用户导入过）才允许注入 wasm 脚本。
// 没模型就注入的话，加载器会先 fetch 一个 404 的 .data，再把 pthread worker 池
// 初始化到半死状态——用户随后导入模型也难以恢复。扩展恒有包内 .data，不受影响。
setPreloadGate(async () => {
  if (await hasBundledResource(ASR_DATA_PATH)) return true;
  try {
    const blob = await getModelFile(ASR_DB_KEY);
    return !!(blob && blob.size > 0);
  } catch { return false; }
});

// 字幕浮窗尺寸：宽条 + 深色底，与扩展的悬浮字幕窗观感一致
const SUBTITLE_WIN_WIDTH = 780;
const SUBTITLE_WIN_HEIGHT = 200;
// 面板「显示字幕」开关：会话开始时按它决定要不要自动开窗
let subtitleWantOpen = true;

function openSubtitleWindow(): Window | null {
  const existing = onSubtitleWindowRef();
  if (existing && !existing.closed) { existing.focus(); return existing; }
  const w = window.open(
    resolveUrl('subtitle.html'),
    'easysub-subtitle',
    // popup=yes 必须显式写：只给尺寸时部分浏览器会把它开成普通标签页而不是独立小窗，
    // 那样"浮窗"就名不副实（用户以为坏了）。toolbar/location 等一并关掉，观感同扩展的弹窗。
    `popup=yes,width=${SUBTITLE_WIN_WIDTH},height=${SUBTITLE_WIN_HEIGHT},menubar=no,toolbar=no,location=no,status=no,resizable=yes`,
  );
  setSubtitleWindowRef(w);
  return w;
}

// —— 跨窗口通道：字幕浮窗回来的消息（锁定切换、浮窗关闭）——
initChannel('panel', (msg) => handleFromSubtitle(msg), () => {
  // 浮窗重新握手（首次连接、或面板刷新后靠心跳自愈）：补推偏好与当前状态，
  // 否则刷新过的面板会把"仍活着的浮窗"留在一个没有显示设置的空白状态。
  void primeSubtitlePrefs();
  sendToPeer({ type: 'STATUS_CHANGED', status: getSessionStatus() });
});

// —— 宿主钩子 ——
const hooks: PanelHostHooks = {
  // 「开始」按钮的第一件事，必须发生在用户手势内：开字幕浮窗 + 预取屏幕共享流。
  // 坑：面板的启动链路里隔着 ensureAsrModel()（至少一次 fetch，首次还要下载 412MB），
  // 等它结束再调 getDisplayMedia 会因"缺少瞬时用户激活"被浏览器直接拒绝——
  // 所以这两件事都必须在点击任务的最前面做掉。
  async prepareStart(source) {
    syncSubtitleOpenFlag();
    if (subtitleWantOpen) openSubtitleWindow();
    void primeSubtitlePrefs();
    // 坑：模型没装时**绝不能先弹屏幕选择器**。首次安装模型要下载 412MB（分钟级），
    // 等它下完用户激活早已过期，preStream 只能被丢弃——屏幕上却留下过一次"已共享"
    // 的痕迹，用户观感极差。模型缺失时直接放行给面板的引导流程，并回报
    // modelPending，让面板在引导结束后请用户重新点一次（那一次才是新鲜手势）。
    if (!(await isAsrModelReady())) return { modelPending: true };
    const stream = await preAcquireAudio(source);
    return stream ? { preStream: stream } : {};
  },

  // 音源下拉：Web 版没有"当前标签页"，摘掉该项
  customizeSources(sel) {
    sel.querySelector('option[value="tab"]')?.remove();
    if (sel.value === 'tab') sel.value = 'system';
  },

  // 系统音频提示：**Web 版不做平台限制**（用户明确要求）。
  // 扩展 offscreen 文档里只有"共享整个屏幕 + 勾系统音频"一条路，平台不支持就是真没戏；
  // 而网页里 getDisplayMedia 还能选"共享某个标签页 + 共享标签页音频"，
  // 这条路在 Linux 上也能拿到声音——所以只给操作指引，不下"不支持"的结论。
  sourceHint(source, lang) {
    if (source === 'system') return tSync(lang, 'sourceHintSystem');
    return undefined;
  },

  // 模型刚装好：现在才注入 wasm 脚本（早于此的预热会被门卫拦下，见 setPreloadGate）
  onModelReady() {
    preloadEngine();
  },

  // 文案定制：把以"浏览器之外/标签页"为前提的话术换成 Web 版说法。
  // 每次 applyLang 都会重跑（含语言切换），所以环境提示也在这里跟着语言刷新。
  customizeText(lang) {
    const tip = document.getElementById('sourceTip');
    if (tip) tip.textContent = tSync(lang, 'webSourceTip');
    (window as any).__easysubRefreshReadiness?.(lang);
  },
};

function syncSubtitleOpenFlag() {
  const chk = document.getElementById('chkOverlay') as HTMLInputElement | null;
  if (chk) subtitleWantOpen = chk.checked;
}

// —— 启动 ——
installWebHost();
mountPanel(hooks);
preloadEngine();
void primeSubtitlePrefs();

// 面板关闭/刷新：通知浮窗（避免留下一个再也收不到字幕的空窗）
window.addEventListener('beforeunload', () => {
  sendToPeer({ type: '__panel_unload' });
  stopChannel();
});

// 「打开字幕浮窗」按钮（Web 版头部）——点击本身就是用户手势，window.open 合法
document.getElementById('btnWebOpenFloat')?.addEventListener('click', () => {
  subtitleWantOpen = true;
  openSubtitleWindow();
});

// 面板上的「显示字幕」勾选变化：勾上就开窗（change 事件仍在用户手势内）
document.getElementById('chkOverlay')?.addEventListener('change', (e) => {
  subtitleWantOpen = (e.target as HTMLInputElement).checked;
  if (subtitleWantOpen) openSubtitleWindow();
});

// —— 启动前置条件自检：把"点开始必然失败"的原因在页面加载时就摆到用户眼前 ——
// 两个条件缺一不可，且都不是用户能猜到的：
//   ① 安全上下文：http:// 非本机时 getUserMedia / getDisplayMedia 根本不存在；
//   ② 跨源隔离：sherpa 的 wasm 是 pthreads 构建，需要 SharedArrayBuffer，
//      而 SAB 只在 crossOriginIsolated 下可用（静态托管靠 coi-serviceworker.js 补）。
// 检测放在加载时而不是点「开始」时，用户一进页面就知道要不要先处理环境。
// 坑：提示必须写进 #webNote（常驻说明区），**不能**写进 #modelStatus ——
// 后者是引擎日志的单行出口，wasm 预热/"模型尚未安装"等日志会立刻把它冲掉，
// 用户根本读不到环境不合格这句最关键的提示。
function reportStartupReadiness() {
  const note = document.getElementById('webNote');
  const tr = (k: string) => tSync((window as any).__easysubLang || 'zh_CN', k);
  const reason = !window.isSecureContext ? 'webNeedSecureContext'
    : !window.crossOriginIsolated ? 'webNoIsolation'
    : null;
  if (!reason) return false;
  if (note) {
    note.textContent = tr(reason);
    note.style.borderColor = '#f0a020';
    note.style.color = 'var(--text)';
  }
  return true;
}
const notReady = reportStartupReadiness();

// 隔离态就绪后（coi-serviceworker 触发的那次自动刷新之后）页面自然重启，
// 这里只需在语言切换时让提示跟着走：宿主钩子的 customizeText 会重刷。
// 把状态暴露给宿主钩子，供语言切换时重算同一段提示。
function refreshReadinessHint(lang: string) {
  // 环境不达标：重写常驻提示（语言切换后要跟着变）
  if (notReady) {
    const note = document.getElementById('webNote');
    if (note) note.textContent = tSync(lang, window.isSecureContext ? 'webNoIsolation' : 'webNeedSecureContext');
    return;
  }
  // 环境达标：把常驻说明还原成模型提示（避免上次的不合格文案残留在页面上）
  const note = document.getElementById('webNote');
  if (note) {
    note.textContent = tSync(lang, 'webModelNote');
    note.style.borderColor = '';
    note.style.color = '';
  }
}
(window as any).__easysubRefreshReadiness = refreshReadinessHint;

// 调试入口（控制台里查会话状态、手动开关浮窗）
(window as any).__easysubWeb = { getSessionStatus, openSubtitleWindow, hasPeer };
