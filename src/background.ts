import { t } from './i18n';
const PENDING_KEY = 'pendingInit';
let captureTabId: number | null = null;
let pipelineStatus = 'Stopped';
let overlayLocked = false;
let offscreenPort: chrome.runtime.Port | null = null;
let reconnectTimer: any = null;

function sendToPopup(msg: any) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function sendToTab(tabId: number, msg: any) {
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

function appendTranscript(text: string) {
  chrome.storage.local.get('tmspeech_transcript').then(r => {
    const arr: string[] = (r['tmspeech_transcript'] as string[]) || [];
    arr.push(text);
    chrome.storage.local.set({ 'tmspeech_transcript': arr });
  });
}

async function ensureOffscreen() {
  const exists = await chrome.offscreen.hasDocument();
  if (exists) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'] as any,
    justification: 'Speech recognition audio processing',
  });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'offscreen') return;
  offscreenPort = port;

  port.onMessage.addListener((msg) => {
    if (msg.type === 'FW_CT' && captureTabId) {
      sendToTab(captureTabId, msg.payload);
    }
    if (msg.type === 'FW_POP') {
      sendToPopup(msg.payload);
      if (msg.payload?.type === 'STATUS_CHANGED') pipelineStatus = msg.payload.status;
      if (msg.payload?.type === 'ERROR') cleanupAll();
      if (msg.payload?.type === 'SENTENCE_DONE') appendTranscript(msg.payload.text);
      if (msg.payload?.type === 'LOG') console.log('[TM BG]', msg.payload.message);
      if (msg.payload?.type === 'RECONNECT') {
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        console.log('[TM BG] offscreen 重连, status=', msg.payload.status, 'tabId=', msg.payload.tabId);
        pipelineStatus = msg.payload.status;
        if (msg.payload.tabId && msg.payload.status === 'Running') {
          captureTabId = msg.payload.tabId;
          const id = captureTabId!;
          sendToTab(id, { type: 'OVERLAY_TOGGLE', visible: true });
          (async () => { sendToTab(id, { type: 'TEXT_CHANGED', text: await t('waiting') }); })();
          chrome.storage.local.get('tmspeech_prefs').then(r => {
            const prefs = (r['tmspeech_prefs'] as any) || {};
            if (prefs.fontSize) {
              sendToTab(id, { type: 'SET_FONT_SIZE', fontSize: prefs.fontSize });
            }
          });
          sendToPopup({ type: 'STATUS_CHANGED', status: 'Running' });
        }
      }
    }
  });

  port.onDisconnect.addListener(() => {
    console.log('[TM BG] offscreen 端口断开, pipelineStatus=', pipelineStatus);
    if (offscreenPort !== port) return;
    offscreenPort = null;
    if (pipelineStatus !== 'Running') return;
    console.log('[TM BG] offscreen 断开，等待重连...');
    reconnectTimer = setTimeout(() => {
      if (pipelineStatus !== 'Running') return;
      console.log('[TM BG] 重连超时，清理');
      pipelineStatus = 'Stopped';
      if (captureTabId) {
        sendToTab(captureTabId, { type: 'OVERLAY_TOGGLE', visible: false });
        captureTabId = null;
      }
      chrome.storage.session.remove(PENDING_KEY);
      sendToPopup({ type: 'STATUS_CHANGED', status: 'Stopped' });
      sendToPopup({ type: 'ERROR', message: '后台页面意外关闭，识别已停止' });
    }, 3000);
  });

  checkPendingInit(port);
});

async function checkPendingInit(port: chrome.runtime.Port) {
  const stored = await chrome.storage.session.get(PENDING_KEY);
  if (stored[PENDING_KEY]) {
    port.postMessage(stored[PENDING_KEY]);
    chrome.storage.session.remove(PENDING_KEY);
  }
}

async function isContentScriptInjected(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    return true;
  } catch { return false; }
}

function hideOverlay(tabId: number | null) {
  if (tabId) sendToTab(tabId, { type: 'OVERLAY_TOGGLE', visible: false });
}

function cleanupAll() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  const tabId = captureTabId;
  pipelineStatus = 'Stopped';
  hideOverlay(tabId);
  chrome.storage.session.remove(PENDING_KEY);
  if (offscreenPort) offscreenPort.postMessage({ type: 'STOP_OFFSCREEN' });
  chrome.offscreen.closeDocument().catch(() => {});
  offscreenPort = null;
  captureTabId = null;
  // 重试一次，防止 content script 未就绪
  if (tabId) setTimeout(() => hideOverlay(tabId), 300);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'START_RECOGNITION') {
    (async () => {
      // 确保前一次的 offscreen 文档完全关闭，释放 tab capture 流
      await chrome.offscreen.closeDocument().catch(() => {});
      // closeDocument 会触发 onDisconnect 置空 offscreenPort
      chrome.storage.session.remove(PENDING_KEY);

      pipelineStatus = 'Running';
      captureTabId = msg.tabId || null;
      if (captureTabId && msg.overlayVisible) {
        const alreadyInjected = await isContentScriptInjected(captureTabId);
        if (!alreadyInjected) {
          await chrome.scripting.executeScript({
            target: { tabId: captureTabId },
            files: ['content.js'],
          }).catch(() => {});
        }
        sendToTab(captureTabId, { type: 'OVERLAY_TOGGLE', visible: true });
        chrome.storage.local.get('tmspeech_prefs').then(r => {
          const prefs = (r['tmspeech_prefs'] as any) || {};
          if (prefs.fontSize) sendToTab(captureTabId!, { type: 'SET_FONT_SIZE', fontSize: prefs.fontSize });
        });
      }

      let streamId: string | undefined;
      if (msg.tabId) {
        streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: msg.tabId });
      }

      await ensureOffscreen();

      const lang = (await chrome.storage.local.get('tmspeech_lang'))['tmspeech_lang'] || 'zh_CN';
      const punctPref = (await chrome.storage.local.get('tmspeech_use_punct'))['tmspeech_use_punct'];
      const initMsg = { type: 'INIT_OFFSCREEN', streamId, tabId: msg.tabId, lang, usePunct: punctPref !== false };
      if (offscreenPort) {
        offscreenPort.postMessage(initMsg);
      } else {
        await chrome.storage.session.set({ [PENDING_KEY]: initMsg });
      }

      sendResponse({});
    })().catch((e) => {
      sendToPopup({ type: 'ERROR', message: `启动失败: ${e}` });
      cleanupAll();
      sendResponse({});
    });

    return true;
  }

  if (msg.type === 'INJECT_TEST') {
    (async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs[0]?.id;
      if (tabId) {
        const already = await isContentScriptInjected(tabId);
        if (!already) {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ['content.js'],
          }).catch(() => {});
        }
        sendToTab(tabId, { type: 'TEST_SHOW' });
      }
    })();
  }

  if (msg.type === 'GET_STATUS') {
    sendResponse({ status: pipelineStatus, locked: overlayLocked });
    return true;
  }

  if (msg.type === 'OVERLAY_TOGGLE') {
    if (captureTabId) sendToTab(captureTabId, { type: 'OVERLAY_TOGGLE', visible: msg.visible });
  }

  if (msg.type === 'LOCK_TOGGLE') {
    overlayLocked = msg.locked;
    if (captureTabId) sendToTab(captureTabId, { type: 'LOCK_TOGGLE', locked: msg.locked });
  }

  if (msg.type === 'SET_FONT_SIZE') {
    if (captureTabId) sendToTab(captureTabId, { type: 'SET_FONT_SIZE', fontSize: msg.fontSize });
  }

  if (msg.type === 'LOCK_CHANGED_FROM_CONTENT') {
    overlayLocked = msg.locked;
    sendToPopup({ type: 'LOCK_CHANGED', locked: msg.locked });
  }

  if (msg.type === 'STOP_RECOGNITION') {
    cleanupAll();
  }

  if (msg.type === 'SET_PUNCT') {
    if (offscreenPort) offscreenPort.postMessage({ type: 'SET_PUNCT', enabled: msg.enabled });
  }

  if (msg.type === 'RESET_OVERLAY_POSITION') {
    if (captureTabId) sendToTab(captureTabId, { type: 'RESET_OVERLAY_POSITION' });
  }

  if (msg.type === 'FORWARD_TO_CONTENT') {
    if (captureTabId) sendToTab(captureTabId, msg.payload);
  }

  if (msg.type === 'FORWARD_TO_POPUP') {
    sendToPopup(msg.payload);
    if (msg.payload?.type === 'STATUS_CHANGED') pipelineStatus = msg.payload.status;
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== captureTabId || changeInfo.status !== 'complete' || pipelineStatus !== 'Running') return;
  setTimeout(() => {
    chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }).then(() => {
      sendToTab(tabId, { type: 'OVERLAY_TOGGLE', visible: true });
      chrome.storage.local.get('tmspeech_prefs').then(r => {
        const prefs = (r['tmspeech_prefs'] as any) || {};
        if (prefs.fontSize) sendToTab(tabId, { type: 'SET_FONT_SIZE', fontSize: prefs.fontSize });
      });
      if (offscreenPort) offscreenPort.postMessage({ type: 'RESEND_CURRENT_TEXT' });
    }).catch(() => {});
  }, 300);
});
