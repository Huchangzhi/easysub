// 纯 Web 版宿主：扮演扩展里 background + offscreen 两个角色的合体。
//
// 架构对照（为什么这么分）：
//   扩展：popup(控制) → background(SW 路由) → offscreen(识别引擎) + floating(字幕窗/麦克风采集)
//   Web ：panel(控制) → **本文件(路由 + 识别引擎)** → subtitle(字幕浮窗，独立 window)
// 差异的根源是 Web 没有 SW/offscreen 这种"无界面常驻上下文"，只能把引擎放进某个真实页面。
// 选面板页承载引擎而不是浮窗，原因有二：
//   ① getDisplayMedia / getUserMedia 都要求**瞬时用户手势**，而面板的「开始」按钮就是那个手势
//      （浮窗是 window.open 出来的，拿不到激活态，还得让用户再点一次）；
//   ② 面板页藏着不动也没关系——音频泵由 AudioWorklet 在音频线程主动 push 出块
//      （见 public/audio-worklet-processor.js 的"双模式出块"注释），不依赖主线程定时器。
//
// 纪律：本文件只做路由与宿主接线，识别/标点/翻译/采集全在共享模块里
// （asr-engine.ts / mic-capture.ts / transcript-store.ts），保证与扩展行为一致。
import { AsrEngine } from '../asr-engine';
import { MicCapture } from '../mic-capture';
import { emitToPanel, onHostMessage, resolveUrl, storage } from '../platform';
import { tSync } from '../i18n';
import { appendTranscript, attachTranscriptTranslation } from '../transcript-store';
import { sendToPeer } from './channel';

// 电平快照（最近 ~7s）：面板每次打开都要能看到上一段波形，而不是从空基线重填。
// 与扩展 background 里的 bgLevels 同口径（60 条 × 120ms）。
const LEVEL_SNAPSHOT_MAX = 60;
const levels: number[] = [];

let engine: AsrEngine | null = null;
// 会话语言（由面板随 START_RECOGNITION 带来）：错误文案按它取 i18n
let msgLang = 'zh_CN';
let mic: MicCapture | null = null;
let status = 'Stopped';
let startedAt = 0;
let locked = false;

function getEngine(): AsrEngine {
  if (!engine) {
    engine = new AsrEngine({
      resolveUrl,
      sink: {
        log: (message) => emitToPanel({ type: 'LOG', message }),
        toDisplay: (payload) => sendToPeer(payload),
        toPanel: (payload) => {
          const p = payload || {};
          // —— 与扩展 background 的 FW_POP 分支等价的三件宿主侧副作 ——
          // ① 定稿译文按 seq 挂到历史原句（跨刷新留存）
          if (p.type === 'TRANSLATION_FINAL') {
            attachTranscriptTranslation(p.text, p.seq, (e) => console.log('[EasySub] 转写译文持久化失败:', e));
          }
          // ② 电平快照（面板关闭/未打开时也要攒着，重开面板能还原波形）
          if (p.type === 'LEVEL') {
            levels.push(Math.max(0, Math.min(1, Number(p.v) || 0)));
            if (levels.length > LEVEL_SNAPSHOT_MAX) levels.shift();
          }
          // ③ 会话状态推进（含计时基准盖章）；SENTENCE_DONE 单独盖章后转发，
          //    避免面板收到两条（一条无 ts 一条有）导致列表重复
          if (p.type === 'STATUS_CHANGED') {
            status = p.status;
            if (p.status === 'Running' && !startedAt) startedAt = Date.now();
            emitToPanel({ ...p, startedAt });
          } else if (p.type === 'SENTENCE_DONE') {
            const ts = Date.now();
            emitToPanel({ ...p, ts });
            appendTranscript(p.text, ts, (e) => console.log('[EasySub] 转写持久化失败:', e));
          } else {
            emitToPanel(p);
          }
          // ERROR：音频注定进不来，收敛成一次可见的停止（同扩展的 cleanupAll）
          if (p.type === 'ERROR') stopSession();
        },
        // 采集彻底起不来（用户关掉屏幕选择器、音频轨异常）→ 立即收敛会话，
        // 否则面板停在"识别中"、浮窗空挂，成为没有任何反馈的幽灵会话。
        requestStop: () => stopSession(),
      },
    });
  }
  return engine;
}

// 停止：停引擎、停麦克风采集、把状态收敛给面板与浮窗。
// 幂等——ERROR / FW_STOP / 用户点停止 三条路都会走到这里。
function stopSession() {
  mic?.stop();
  engine?.stop();
  status = 'Stopped';
  startedAt = 0;
  emitToPanel({ type: 'STATUS_CHANGED', status: 'Stopped' });
  sendToPeer({ type: 'STATUS_CHANGED', status: 'Stopped' });
}

export function getSessionStatus() { return status; }

// 字幕浮窗的窗口引用由面板（web/panel.ts）用 window.open 建好后交给这里保管：
// 宿主在会话结束时需要主动关窗，而 panel 侧不该关心"谁负责关窗"这类路由细节。
let subtitleWindow: Window | null = null;
export function onSubtitleWindowRef(): Window | null {
  return subtitleWindow && !subtitleWindow.closed ? subtitleWindow : null;
}
export function setSubtitleWindowRef(w: Window | null) { subtitleWindow = w; }

// 面板点「开始」时同步（在用户手势内）预取音频流。Web 版必须这么做：
// 面板的启动链路里 `await ensureAsrModel()` 会跨过若干微任务/网络请求，
// 等它结束再调 getDisplayMedia，浏览器会以"缺少瞬时用户激活"直接拒绝。
// 所以由面板在点击任务的最前面调用本函数，把流先拿到手，再走后面的异步检查。
export async function preAcquireAudio(source: string): Promise<MediaStream | null> {
  if (source !== 'system') return null;
  try {
    return await getEngine().acquireSystemAudioStream();
  } catch (e: any) {
    // 用户关掉选择器（NotAllowedError/AbortError）由调用方按取消处理，这里原样抛出
    throw e;
  }
}

async function startSession(msg: any) {
  const source = msg.source === 'mic' ? 'mic' : 'system';
  // 会话语言：错误文案要用会话启动时的语言（面板切语言后重开会话才变，与扩展一致）
  if (msg.lang) msgLang = msg.lang;
  // 先停干净上一场（含上一场的 getDisplayMedia 轨道），避免两份采集并存
  mic?.stop();
  engine?.stop();
  status = 'Running';
  startedAt = Date.now();

  (async () => {
    const e = getEngine();
    await e.init({
      source,
      lang: msg.lang || 'zh_CN',
      usePunct: msg.usePunct,
      endpointRule1: msg.endpointRule1,
      endpointRule2: msg.endpointRule2,
      endpointRule3: msg.endpointRule3,
      hotwords: msg.hotwords,
      translationEnabled: msg.translationEnabled,
      translationDirection: msg.translationDirection,
      translationTiming: msg.translationTiming,
      // 面板预取的屏幕共享流（system 音源）：引擎拿到就直接接入管道，
      // 不再自己调 getDisplayMedia（那时已不在用户手势内，必失败）
      preStream: msg.preStream ?? null,
    });
  })().catch((e) => {
    console.log('[EasySub] 启动失败:', e);
    emitToPanel({ type: 'ERROR', message: `启动失败: ${e?.message || e}` });
    stopSession();
  });

  if (source === 'mic') {
    // 麦克风：采集放本宿主（面板页是可见窗口，授权弹窗能正常出现），
    // PCM 经 feedMicChunk 喂进识别管道——与扩展"悬浮窗采集、bg 中转"同一协议。
    mic = new MicCapture({
      onChunk: (f32, sampleRate) => getEngine().feedMicChunk(f32, sampleRate),
      onError: (name, error) => {
        // 文案走 i18n（双语），与扩展悬浮窗的 MIC_RESULT 分支同一套键
        emitToPanel({
          type: 'ERROR',
          message: name === 'NotAllowedError'
            ? tSync(msgLang, 'micDenied')
            : name === 'TrackEnded'
              ? tSync(msgLang, 'micTrackEnded')
              : `${tSync(msgLang, 'micFailFallback')} ${error || ''}`.trim(),
        });
        stopSession();
      },
    });
    void mic.start();
  }
}

// —— 面板 → 宿主 的消息路由 ——
// 消息名与扩展的 background 完全一致，面板因此不需要区分宿主。
export function installWebHost() {
  onHostMessage((msg: any) => {
    switch (msg?.type) {
      case 'START_RECOGNITION':
        void startSession(msg);
        return true;

      case 'STOP_RECOGNITION':
        stopSession();
        return true;

      case 'GET_STATUS':
        // 契约与扩展 background 的 GET_STATUS 一致：面板据此恢复状态、锁态与波形快照
        return { status, startedAt, locked, levels: levels.slice() };

      case 'OVERLAY_TOGGLE':
        // 显示/隐藏字幕：Web 版即"字幕浮窗开/关"
        sendToPeer({ type: 'OVERLAY_TOGGLE', visible: msg.visible });
        return true;

      case 'LOCK_TOGGLE':
        locked = msg.locked === true;
        sendToPeer({ type: 'LOCK_TOGGLE', locked: locked });
        return true;

      case 'LOCK_CHANGED_FROM_CONTENT':
        // 浮窗里点锁定按钮 → 回传，面板同步勾选态
        locked = msg.locked === true;
        emitToPanel({ type: 'LOCK_CHANGED', locked });
        return true;

      case 'SET_FONT_SIZE':
      case 'SET_PREV_OPTS':
      case 'RESET_OVERLAY_POSITION':
      case 'SET_PUNCT':
        sendToPeer(msg.type === 'SET_PUNCT'
          ? { type: 'SET_PUNCT', enabled: msg.enabled }
          : msg);
        if (msg.type === 'SET_PUNCT') engine?.setPunctuation(msg.enabled !== false);
        return true;

      case 'SET_ENDPOINT':
        // 端点阈值在识别器创建时一次性烘焙，运行时只记日志（与扩展一致：重启生效）
        engine?.logEndpoint(msg.rule1, msg.rule2, msg.rule3);
        return true;

      case 'FORWARD_TO_CONTENT':
        // 面板的显示类偏好改动（PREFS_PATCH / OVERLAY_TOGGLE 等）实时推到字幕浮窗
        sendToPeer(msg.payload);
        return true;

      case 'TRANSLATE_TEST':
        // 面板的"测试翻译"：直接问引擎（Web 版没有跨上下文转发层）
        return getEngine().testTranslate(String(msg.text ?? ''), msg.direction || 'auto')
          .then((r) => r);

      case 'TRANSLATE_TEST_CANCEL':
        engine?.cancelTranslateTest();
        return true;

      case 'OPEN_FLOATING':
      case 'CLOSE_FLOATING':
        // 这两个在扩展里由 background 管窗口；Web 版的字幕浮窗由面板自己 window.open，
        // 这里只做空实现，避免面板收到 undefined 之后误判失败。
        return true;
    }
    return undefined;
  });
}

// 预热 wasm：面板页一加载就开始把模型读成 blob URL 并注入三个 wasm 脚本，
// 「开始」到出字的空窗因此明显更短（与扩展 offscreen 文档的预加载行为一致）。
export function preloadEngine(): void {
  void getEngine().preload().catch((e) => console.log('[EasySub] wasm 预加载失败:', e));
}

// 字幕浮窗回来的消息：目前只有"锁定切换"（用户在浮窗里点了锁）
// 面板侧需要同步勾选态，所以转成与扩展同名的消息发给面板。
export function handleFromSubtitle(msg: any) {
  if (msg?.type === 'LOCK_CHANGED_FROM_CONTENT') {
    locked = msg.locked === true;
    emitToPanel({ type: 'LOCK_CHANGED', locked });
    return;
  }
  if (msg?.type === 'STOP_RECOGNITION' || msg?.type === '__subtitle_stop') {
    // 浮窗工具条的「停止」按钮、以及浮窗关掉画中画窗口时的收尾，都走这里。
    // 坑：这条消息名与面板发出的同名，但**来源是浮窗**——早先只处理了锁定回传，
    // 浮窗里点停止毫无反应（用户会以为按钮坏了）。
    stopSession();
    return;
  }
  if (msg?.type === '__subtitle_closed') {
    // 浮窗被用户关掉：识别继续（音频采集在面板页，不受影响），
    // 但字幕无处可显示——给一条可见提示，避免用户以为识别挂了。
    emitToPanel({ type: 'LOG', message: '字幕浮窗已关闭（识别仍在进行）' });
  }
}

// 会话开始前把面板的偏好快照推给浮窗（浮窗可能是刚打开的，尚未读到任何消息）
export async function primeSubtitlePrefs(): Promise<void> {
  const r = await storage.get(['tmspeech_prefs', 'tmspeech_locked', 'tmspeech_lang']);
  const prefs = (r['tmspeech_prefs'] as any) || {};
  sendToPeer({ type: 'PREFS_PATCH', ...prefs });
  locked = r['tmspeech_locked'] === true;
  sendToPeer({ type: 'LOCK_TOGGLE', locked });
}
