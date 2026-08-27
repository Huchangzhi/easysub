// 离线翻译 worker：被 offscreen 文档创建，专门跑 transformers.js 推理，
// 把耗时的句级翻译从主线程（音频泵/ASR 所在线程）隔离出去，不阻塞识别。
// 模型文件由用户在面板用 <input type=file> 选目录读入 IndexedDB（见 model-db.ts），
// 这里重写 fetch 把 transformers.js 的本地模型请求映射到 IndexedDB，全程零网络零权限。
import { pipeline, env } from '@huggingface/transformers';
import { getModelFile, listModelKeys } from './model-db';

type Pipe = any;

// 方向 → 模型目录名（与发布到 GitHub Releases 的模型包目录一一对应）
const MODEL_PAIRS: Record<string, string> = {
  'en-zh': 'opus-mt-en-zh',
  'zh-en': 'opus-mt-zh-en',
};

let setupDone = false;
let setupError: string | null = null;
const pipes: Record<string, Pipe> = {};

function isCJK(text: string): boolean {
  return /[\u3400-\u4dbf\u4e00-\u9fff]/.test(text);
}

function modelIdFor(direction: 'auto' | 'zh-en' | 'en-zh', text: string): string {
  const dir = direction === 'auto' ? (isCJK(text) ? 'zh-en' : 'en-zh') : direction;
  return MODEL_PAIRS[dir];
}

// 坑：transformers.js 请求的本地 URL 形如 `tmspeech://opus-mt-en-zh/config.json`，
// 但路径可能带 revision 段（`opus-mt-en-zh/main/config.json`），去掉 revision 再查。
async function resolveFile(key: string): Promise<Blob | null> {
  const exact = await getModelFile(key);
  if (exact) return exact;
  const parts = key.split('/');
  if (parts.length > 2) {
    const short = parts[0] + '/' + parts[parts.length - 1];
    return getModelFile(short);
  }
  return null;
}

function setup() {
  if (setupDone || setupError) return;
  try {
    env.allowRemoteModels = false;
    env.useBrowserCache = false;
    env.localModelPath = 'tmspeech://';
    // 只跑 wasm 单线程，避免 onnxruntime-web 起 worker/proxy 撞上 MV3 CSP
    const wasmCfg = env.backends.onnx.wasm;
    if (wasmCfg) {
      wasmCfg.numThreads = 1;
      wasmCfg.proxy = false;
      wasmCfg.wasmPaths = chrome.runtime.getURL('ort-wasm/');
    }

    const origFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : (input?.url ?? '');
      if (url.startsWith('tmspeech://')) {
        const key = url.slice('tmspeech://'.length).replace(/^\/+/, '');
        return resolveFile(key).then(blob => {
          if (!blob) throw new Error('翻译模型文件缺失: ' + key);
          return new Response(blob, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
        });
      }
      return origFetch(input, init);
    };
    setupDone = true;
  } catch (e: any) {
    setupError = e?.message || String(e);
  }
}

async function getPipeline(modelId: string): Promise<Pipe | null> {
  if (pipes[modelId]) return pipes[modelId];
  // 模型是否已安装：IndexedDB 里存在该目录下任何文件
  const keys = await listModelKeys();
  const installed = keys.some(k => k.startsWith(modelId + '/'));
  if (!installed) return null;
  // 复用 model-db 里同名导出，避免重复打开连接（keys 已在上面取到，直接判断即可）
  const pipe: Pipe = await pipeline('translation', modelId, { dtype: 'q8' });
  pipes[modelId] = pipe;
  return pipe;
}

async function translate(text: string, direction: 'auto' | 'zh-en' | 'en-zh'): Promise<string | null> {
  setup();
  if (setupError) throw new Error(setupError);
  const modelId = modelIdFor(direction, text);
  const pipe = await getPipeline(modelId);
  if (!pipe) return null;
  // num_beams:1 覆盖模型默认 beam=4，单线程 wasm 下快约一个量级
  const out = await pipe(text, { num_beams: 1, max_new_tokens: 128 });
  const first = (Array.isArray(out) ? out[0] : out) as any;
  const result = first?.generated_text ?? '';
  return result.trim() || null;
}

let msgId = 0;

self.onmessage = (e: MessageEvent) => {
  const msg = e.data || {};
  if (msg.type !== 'TRANSLATE') return;
  const id = ++msgId;
  const kind = msg.kind === 'final' ? 'final' : 'stream';
  (async () => {
    try {
      const text = await translate(String(msg.text ?? ''), msg.direction || 'auto');
      postMessage({
        type: 'TRANSLATION', id, kind,
        text, ok: text != null,
        reason: text == null ? 'no-model' : null,
        error: null,
      });
    } catch (err: any) {
      postMessage({ type: 'TRANSLATION', id, kind, text: null, ok: false, reason: 'error', error: err?.message || String(err) });
    }
  })();
};
