import { Pipeline, JobStatus } from './pipeline';

let pipeline: Pipeline | null = null;
let port: chrome.runtime.Port;
let reconnectTabId: number | null = null;
let reconnectStreamId: string | null = null;

function log(msg: string) {
  console.log('[易字幕 Offscreen]', msg);
  try { port.postMessage({ type: 'FW_POP', payload: { type: 'LOG', message: msg } }); } catch {}
}

function sendSafe(type: string, payload: any) {
  try { port.postMessage({ type, payload }); } catch {}
}

function setupPort() {
  port = chrome.runtime.connect({ name: 'offscreen' });

  port.onDisconnect.addListener(() => {
    console.log('[TM Offscreen] 端口断开');
    if (!pipeline) return; // 已停止，不重连
    console.log('[TM Offscreen] 管道还在运行，1 秒后重连...');
    setTimeout(() => {
      setupPort();
      sendSafe('FW_POP', { type: 'RECONNECT', tabId: reconnectTabId, streamId: reconnectStreamId, status: 'Running' });
    }, 1000);
  });

  port.onMessage.addListener((msg) => {
    if (msg.type === 'INIT_OFFSCREEN') {
      log('收到 INIT_OFFSCREEN');
      reconnectTabId = msg.tabId || null;
      reconnectStreamId = msg.streamId || null;

      pipeline?.stop();
      pipeline = null;

      pipeline = new Pipeline({
        onTextChanged: (text) => {
          sendSafe('FW_CT', { type: 'TEXT_CHANGED', text });
          sendSafe('FW_POP', { type: 'TEXT_CHANGED', text });
        },
        onSentenceDone: (text) => {
          sendSafe('FW_CT', { type: 'SENTENCE_DONE', text, isFinal: true });
          sendSafe('FW_POP', { type: 'SENTENCE_DONE', text });
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
        await waitForWasm();
        sendSafe('FW_CT', { type: 'TEXT_CHANGED', text: '正在等待音频' });
        sendSafe('FW_POP', { type: 'TEXT_CHANGED', text: '正在等待音频' });
        await pipeline!.start(msg.streamId);
      })().catch((e) => {
        log('Pipeline start 异常: ' + (e.message || e));
        sendSafe('FW_POP', { type: 'ERROR', message: `Pipeline启动失败: ${e.message || e}` });
      });
    }

    if (msg.type === 'STOP_OFFSCREEN') {
      log('收到 STOP_OFFSCREEN');
      reconnectTabId = null;
      reconnectStreamId = null;
      pipeline?.stop();
      pipeline = null;
    }
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
