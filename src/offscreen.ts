import { Pipeline, JobStatus } from './pipeline';
import { tSync } from './i18n';
import { addPunctuation } from './punctuator';
import { resample } from './audio-processor';

let pipeline: Pipeline | null = null;
let port: chrome.runtime.Port;
let reconnectTabId: number | null = null;
let reconnectStreamId: string | null = null;
let currentLang = 'zh_CN';
let lastText = '';
let prevSentence = '';
let usePunct = true;
let punctPending = false;
let lastPunctText = '';
// 坑：标点延迟回调的代次令牌。INIT 重启或 STOP 停止时递增，在途的 setTimeout(0) 标点
// 回调触发时发现代次已变就整体丢弃（不写缓存不发消息），防止上一场字幕串进新会话、
// 或停止后字幕被迟到的标点结果"复活"。
let punctEpoch = 0;

// ---- 识别延迟测量（LATENCY_UPDATE 测量端）----
// 指标口径：latEmaMs = 「flush 往返延迟 RTT + 本块同步处理耗时」的指数滑动平均（α=0.2）。
// - RTT：flush 指令发出（主线程）→ worklet 回包到达（主线程）。worklet 侧拼缓冲极快，
//   RTT 主要反映主线程被标点推理等任务阻塞造成的音频消费滞后；
// - 处理耗时：本次 feedAudio（重采样 + 识别解码循环）的同步耗时，识别器积压时上升。
// 局限：不含识别器内部流式缓冲与端点检测的固有等待（如尾静音 0.8s 停顿），所以这是
// "处理链路延迟"的近似，不是严格的音频→字幕端到端时延；数值小仅代表管线未积压。
// 开销：每 60ms 周期只有几次数字运算和一次 EMA 更新——不分配对象、不新增定时器，
// 完全复用现有 flush 路径的时间戳。
let latEmaMs = 0;
let lastFlushSentAt = 0;
let lastLatencySentAt = 0;

function recordLatency(rttMs: number, procMs: number) {
  const sample = rttMs + procMs;
  latEmaMs = latEmaMs === 0 ? sample : latEmaMs * 0.8 + sample * 0.2;
  // 节流坑：≥2 秒最多一条。先查节流窗口再决定是否发，避免每 60ms 都做消息序列化；
  // 用 Date.now() 记录上次发送时刻（墙钟），与 performance.now() 的用途区分开。
  if (Date.now() - lastLatencySentAt < 2000) return;
  // 仅 pipeline Running 时发送；STOP/INIT 后 pipeline 置 null 或非 Running，自然停发，
  // 显示端在停止语义下自行清空残留读数（本端不发"清零"消息）。
  if (!pipeline || pipeline.getStatus() !== JobStatus.Running) return;
  lastLatencySentAt = Date.now();
  sendSafe('FW_CT', { type: 'LATENCY_UPDATE', ms: Math.round(latEmaMs) });
}
let audioCtx: AudioContext | null = null;
let workletNode: AudioWorkletNode | null = null;
let audioEl: HTMLAudioElement | null = null;
let captureStream: MediaStream | null = null;
let fallbackCleanup: (() => void) | null = null;
let flushTimer: any = null;

declare function createOnlineRecognizer(Module: any, config: any): any;

function log(msg: string) {
  console.log('[易字幕 Offscreen]', msg);
  try { port.postMessage({ type: 'FW_POP', payload: { type: 'LOG', message: msg } }); } catch {}
}

function sendSafe(type: string, payload: any) {
  try { port.postMessage({ type, payload }); } catch {}
}

function stopAudio() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (workletNode) { workletNode.port.postMessage('stop'); workletNode.disconnect(); workletNode = null; }
  if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
  fallbackCleanup?.();
  fallbackCleanup = null;
  if (audioEl) { audioEl.pause(); audioEl.srcObject = null; audioEl = null; }
  if (captureStream) { captureStream.getTracks().forEach(t => t.stop()); captureStream = null; }
}

async function startAudioCapture(streamId: string) {
  const constraints: any = {
    audio: {
      mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
    },
  };
  // 坑："Error starting tab capture" 常见于上一次捕获刚被销毁就立刻开新流——
  // Chrome 侧旧流的释放是异步的，立即申请会被拒绝。失败后稍等重试一次；
  // 仍失败则照常抛出，由 INIT 的异常通道把错误上报到弹窗。
  let stream: MediaStream;
  try {
    stream = await (navigator.mediaDevices.getUserMedia as any)(constraints);
  } catch (e) {
    log('tab capture 启动失败，400ms 后重试一次: ' + e);
    await new Promise(r => setTimeout(r, 400));
    stream = await (navigator.mediaDevices.getUserMedia as any)(constraints);
  }
  captureStream = stream;
  audioEl = document.createElement('audio');
  audioEl.srcObject = stream;
  audioEl.play().catch(() => {});

  if ((self as any).AudioWorklet) {
    try {
      await startWorkletCapture(stream);
      return;
    } catch (e) {
      log('AudioWorklet 启动失败，降级: ' + e);
    }
  }
  startFallbackCapture(stream);
}

async function startWorkletCapture(stream: MediaStream) {
  // ponytail: AudioWorklet 在独立音频线程持续读帧，主线程标点阻塞时照常缓冲
  audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(stream);
  const url = chrome.runtime.getURL('audio-worklet-processor.js');
  // ponytail: audioWorklet.addModule 必须用扩展 URL（blob 被 CSP 'self' 拦截）
  await audioCtx.audioWorklet.addModule(url);

  workletNode = new AudioWorkletNode(audioCtx, 'audio-buffer');
  source.connect(workletNode);

  workletNode.port.onmessage = (e: MessageEvent) => {
    if (e.data && e.data.audio) {
      const buf = new Float32Array(e.data.audio);
      if (buf.length > 0) {
        const sr = e.data.sampleRate || audioCtx!.sampleRate;
        const arrivedAt = performance.now();
        pipeline?.feedAudio(sr === 16000 ? buf : resample(buf, sr, 16000));
        // 延迟测量：RTT 按"回包到达时刻 - flush 发出时刻"计（不含本块解码耗时，
        // 解码单独计入处理耗时），口径详见 recordLatency 注释。
        recordLatency(lastFlushSentAt > 0 ? Math.max(0, arrivedAt - lastFlushSentAt) : 0,
          performance.now() - arrivedAt);
      }
    }
  };

  function scheduleFlush() {
    flushTimer = setTimeout(() => {
      // 记录 flush 发出时刻供延迟测量使用（复用现有 60ms 路径，不新增定时器）。
      // 若上一轮回包因主线程阻塞迟到，此值被覆盖后 RTT 按最新发送计时——低估近似，可接受。
      lastFlushSentAt = performance.now();
      workletNode?.port.postMessage('flush');
      scheduleFlush();
    }, 60);
  }
  scheduleFlush();
}

function startFallbackCapture(stream: MediaStream) {
  let ctx: AudioContext;
  try {
    ctx = new AudioContext({ sampleRate: 16000 });
  } catch {
    ctx = new AudioContext();
  }
  audioCtx = ctx;
  const source = ctx.createMediaStreamSource(stream);
  const node = ctx.createScriptProcessor(16384, 1, 1);
  node.onaudioprocess = (e) => {
    const buf = new Float32Array(e.inputBuffer.getChannelData(0));
    const t0 = performance.now();
    pipeline?.feedAudio(ctx.sampleRate === 16000 ? buf : resample(buf, ctx.sampleRate, 16000));
    // 降级路径没有 flush RTT 可测，只用同步处理耗时近似（口径见 recordLatency 注释）。
    recordLatency(0, performance.now() - t0);
  };
  source.connect(node);
  // 坑：ScriptProcessorNode 只有被下游拉取（连接到 destination 一侧）时才会驱动，
  // 不连 destination 的话 onaudioprocess 永远不会触发，降级路径采到的是零帧。
  // 但绝不能把捕获流/节点直连 destination——audioEl 已在播放该流，直连会造成
  // 声音双重播放；正确做法是经 gain=0 的 GainNode 桥接：处理链保持活跃且完全静音。
  const muteGain = ctx.createGain();
  muteGain.gain.value = 0;
  node.connect(muteGain);
  muteGain.connect(ctx.destination);
  ctx.resume().catch(() => {});
  fallbackCleanup = () => {
    node.disconnect();
    muteGain.disconnect();
    source.disconnect();
    ctx.close().catch(() => {});
  };
}

function setupPort() {
  port = chrome.runtime.connect({ name: 'offscreen' });

  port.onDisconnect.addListener(() => {
    console.log('[TM Offscreen] 端口断开');
    if (!pipeline) return;
    console.log('[TM Offscreen] 管道还在运行，1 秒后重连...');
    setTimeout(() => {
      setupPort();
      sendSafe('FW_POP', { type: 'RECONNECT', tabId: reconnectTabId, streamId: reconnectStreamId, status: 'Running' });
    }, 1000);
  });

  port.onMessage.addListener((msg) => {
    try {
    if (msg.type === 'INIT_OFFSCREEN') {
      // ponytail: INIT_OFFSCREEN 可能触发两次（重连），__recognizer/__punctuator 只创建一次
      // ponytail: WASM 无法二次加载模型，重建 recognizer 需重启整个 offscreen 文档
      log('收到 INIT_OFFSCREEN');
      reconnectTabId = msg.tabId || null;
      reconnectStreamId = msg.streamId || null;
      if (msg.lang) currentLang = msg.lang;
      usePunct = msg.usePunct !== false;

      stopAudio();
      pipeline?.stop();
      pipeline = null;

      // 坑：跨会话残留的文本状态会让新会话开头闪出上一场的字幕；这里全部清零，
      // 并递增标点代次使所有在途的标点延迟回调失效（回调内部会校验代次）。
      lastText = '';
      prevSentence = '';
      lastPunctText = '';
      punctPending = false;
      punctEpoch++;
      // 延迟测量状态一并归零：新会话从零开始积累 EMA，避免上一场的积压读数串场。
      latEmaMs = 0;
      lastFlushSentAt = 0;
      lastLatencySentAt = 0;

      pipeline = new Pipeline({
        onTextChanged: (text) => {
          lastText = text;
          if (usePunct) {
            const display = lastPunctText || text;
            sendSafe('FW_CT', { type: 'TEXT_CHANGED', text: display })
            sendSafe('FW_POP', { type: 'TEXT_CHANGED', text: display })
            sendSafe('FW_CT', { type: 'OVERLAY_TEXT', prev: prevSentence, current: display })
            if (!punctPending) {
              // ponytail: setTimeout(0) 推迟标点推理，避免同步阻塞 audio pump 丢帧
              // ponytail: lastPunctText 缓存上次结果过渡显示，onSentenceDone 清空防止闪旧文
              punctPending = true;
              const epoch = punctEpoch;
              setTimeout(() => {
                // 坑：回调触发时若会话已重启/停止（代次已变），本次推理整体丢弃：
                // 不写 lastPunctText、不发消息。punctPending 已由 INIT/STOP 重置，无需在此清理。
                if (epoch !== punctEpoch) return;
                punctPending = false;
                lastPunctText = addPunctuation(lastText);
                sendSafe('FW_CT', { type: 'OVERLAY_TEXT', prev: prevSentence, current: lastPunctText })
                sendSafe('FW_CT', { type: 'TEXT_CHANGED', text: lastPunctText })
                sendSafe('FW_POP', { type: 'TEXT_CHANGED', text: lastPunctText })
              }, 0);
            }
          } else {
            sendSafe('FW_CT', { type: 'OVERLAY_TEXT', prev: prevSentence, current: text })
            sendSafe('FW_CT', { type: 'TEXT_CHANGED', text })
            sendSafe('FW_POP', { type: 'TEXT_CHANGED', text })
          }
        },
        onSentenceDone: (text) => {
          // ponytail: addPunctuation 同步调 CT-Transformer 模型推理，会阻塞主线程
          // AudioWorklet 在音频线程持续缓冲，解阻塞后 pipeline 处理积压帧
          prevSentence = usePunct ? addPunctuation(text) : text;
          lastText = '';
          lastPunctText = '';
          sendSafe('FW_CT', { type: 'OVERLAY_TEXT', prev: prevSentence, current: '' });
          sendSafe('FW_CT', { type: 'SENTENCE_DONE', text: prevSentence, isFinal: true });
          sendSafe('FW_POP', { type: 'SENTENCE_DONE', text: prevSentence });
        },
        onStatusChanged: (status) => {
          sendSafe('FW_POP', { type: 'STATUS_CHANGED', status: JobStatus[status] });
        },
        onError: (err) => {
          log('错误: ' + err.message);
          try { pipeline?.stop(); } catch (e) { log('stop 异常: ' + e); }
          sendSafe('FW_POP', { type: 'ERROR', message: err.message });
        },
      });

      (async () => {
        try {
        await waitForWasm();
        if (!(window as any).__recognizer) {
          const r1 = msg.endpointRule1 ?? 0.8;
          const r2 = msg.endpointRule2 ?? 0.6;
          const r3 = msg.endpointRule3 ?? 15;
          (window as any).__recognizer = createOnlineRecognizer((window as any).Module, {
            rule1MinTrailingSilence: r1,
            rule2MinTrailingSilence: r2,
            rule3MinUtteranceLength: Math.round(r3),
          });
        }
        if (usePunct && !(window as any).__punctuator) {
          try {
            (window as any).__punctuator = new (window as any).OfflinePunctuation({
              model: { ctTransformer: 'model.punct.int8.onnx', numThreads: 1, provider: 'cpu' }
            }, (window as any).Module);
          } catch (e) {
            log('标点模型初始化失败: ' + e);
          }
        }
        const waitingText = tSync(currentLang, 'waiting');
        sendSafe('FW_CT', { type: 'TEXT_CHANGED', text: waitingText });
        sendSafe('FW_POP', { type: 'TEXT_CHANGED', text: waitingText });
        await pipeline!.start();
        // 坑：capture streamId 有效期很短，必须在消费前一刻才签发。此刻 WASM/模型已就绪，
        // 向 background 要一个全新的 streamId 并立即开流。旧实现"启动时预签发、
        // 模型加载完才消费"，时间窗一长就报 "Error starting tab capture"。
        sendSafe('FW_POP', { type: 'REQUEST_STREAM', tabId: msg.tabId });
        } catch (e: any) { log('INIT_OFFSCREEN async 异常: ' + (e?.stack || e)); throw e; }
      })().catch((e) => {
        log('Pipeline start 异常: ' + (e.message || e));
        sendSafe('FW_POP', { type: 'ERROR', message: `Pipeline启动失败: ${e.message || e}` });
      });
    }

    if (msg.type === 'SET_PUNCT') {
      usePunct = msg.enabled !== false;
      log('标点功能: ' + (usePunct ? '开' : '关'));
    }

    if (msg.type === 'RESEND_CURRENT_TEXT') {
      if (lastText || prevSentence) {
        sendSafe('FW_CT', { type: 'OVERLAY_TEXT', prev: prevSentence, current: lastText });
        sendSafe('FW_CT', { type: 'TEXT_CHANGED', text: lastText });
        sendSafe('FW_POP', { type: 'TEXT_CHANGED', text: lastText });
      }
    }

    if (msg.type === 'SET_ENDPOINT') {
      log(`端点阈值 saved: ${msg.rule1}/${msg.rule2}/${msg.rule3} (重启生效)`);
    }

    if (msg.type === 'STREAM_READY') {
      // background 对 REQUEST_STREAM 的应答：拿到新鲜 streamId，立即开流。
      if (!pipeline) { log('STREAM_READY 到达时会话已停止，丢弃'); return; }
      log('收到 STREAM_READY，开始音频捕获');
      reconnectStreamId = msg.streamId || null;
      (async () => {
        await startAudioCapture(msg.streamId);
      })().catch((e: any) => {
        log('音频捕获失败: ' + (e?.message || e));
        sendSafe('FW_POP', { type: 'ERROR', message: `${e?.message || e}` });
      });
    }

    if (msg.type === 'STOP_OFFSCREEN') {
      log('收到 STOP_OFFSCREEN');
      reconnectTabId = null;
      reconnectStreamId = null;
      stopAudio();
      pipeline?.stop();
      pipeline = null;
      // 坑：停止同样要作废在途的标点延迟回调，否则迟到的标点结果会把已清空的
      // 字幕重新写回缓存并推给 content/popup，表现为"点了停止字幕又复活"。
      punctPending = false;
      punctEpoch++;
    }
    } catch (e) { log('消息处理异常: ' + ((e as any)?.stack || e)); }
  });
}

setupPort();

// 坑：preload.js 只在 onRuntimeInitialized 成功时置 __wasmReady，失败时没有任何信号，
// 所以这里只能靠超时兜底。超时即认定 WASM 初始化失败，抛错走 INIT 的异常通道
// （外层 catch 会发 FW_POP ERROR），由 background 统一清理；否则轮询永不退出，
// 会话永远停在"等待识别"且无任何错误上报。
async function waitForWasm(): Promise<void> {
  if ((window as any).__wasmReady) return;
  log('等待 WASM 加载...');
  const deadline = Date.now() + 30_000;
  while (!(window as any).__wasmReady) {
    if (Date.now() > deadline) {
      throw new Error('WASM 初始化超时（30s），模型可能加载失败');
    }
    await new Promise(r => setTimeout(r, 200));
  }
  log('WASM 已就绪');
}

log('Offscreen 文档已加载');
