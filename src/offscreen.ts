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
  const stream: MediaStream = await (navigator.mediaDevices.getUserMedia as any)({
    audio: {
      mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
    },
  });
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
  audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(stream);
  const url = chrome.runtime.getURL('audio-worklet-processor.js');
  await audioCtx.audioWorklet.addModule(url);

  workletNode = new AudioWorkletNode(audioCtx, 'audio-buffer');
  source.connect(workletNode);

  workletNode.port.onmessage = (e: MessageEvent) => {
    if (e.data && e.data.audio) {
      const buf = new Float32Array(e.data.audio);
      if (buf.length > 0) {
        const sr = e.data.sampleRate || audioCtx!.sampleRate;
        pipeline?.feedAudio(sr === 16000 ? buf : resample(buf, sr, 16000));
      }
    }
  };

  function scheduleFlush() {
    flushTimer = setTimeout(() => {
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
    pipeline?.feedAudio(ctx.sampleRate === 16000 ? buf : resample(buf, ctx.sampleRate, 16000));
  };
  source.connect(node);
  ctx.resume().catch(() => {});
  fallbackCleanup = () => {
    node.disconnect();
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
      log('收到 INIT_OFFSCREEN');
      reconnectTabId = msg.tabId || null;
      reconnectStreamId = msg.streamId || null;
      if (msg.lang) currentLang = msg.lang;
      usePunct = msg.usePunct !== false;

      stopAudio();
      pipeline?.stop();
      pipeline = null;

      pipeline = new Pipeline({
        onTextChanged: (text) => {
          lastText = text;
          if (usePunct) {
            const display = lastPunctText || text;
            sendSafe('FW_CT', { type: 'TEXT_CHANGED', text: display })
            sendSafe('FW_POP', { type: 'TEXT_CHANGED', text: display })
            sendSafe('FW_CT', { type: 'OVERLAY_TEXT', prev: prevSentence, current: display })
            if (!punctPending) {
              punctPending = true;
              setTimeout(() => {
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
        await startAudioCapture(msg.streamId);
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

    if (msg.type === 'STOP_OFFSCREEN') {
      log('收到 STOP_OFFSCREEN');
      reconnectTabId = null;
      reconnectStreamId = null;
      stopAudio();
      pipeline?.stop();
      pipeline = null;
    }
    } catch (e) { log('消息处理异常: ' + ((e as any)?.stack || e)); }
  });
}

setupPort();

async function waitForWasm(): Promise<void> {
  if ((window as any).__wasmReady) return;
  log('等待 WASM 加载...');
  while (!(window as any).__wasmReady) {
    await new Promise(r => setTimeout(r, 200));
  }
  log('WASM 已就绪');
}

log('Offscreen 文档已加载');
