import { Pipeline, JobStatus } from './pipeline';
import { tSync } from './i18n';
import { addPunctuation } from './punctuator';
import { resample } from './audio-processor';
import { getModelFile } from './model-db';

// ---- wasm 脚本动态注入（nomodel 版支持）----
// offscreen.html 只静态加载 preload.js（仅定义 Module 不拉资源）。三个 wasm 脚本必须等
// IndexedDB 检查完成后再注入：nomodel 包里没有 .data，需要先把用户导入的模型读成 blob URL
// 挂到 window.__asrDataUrl，preload.js 的 locateFile 会在加载器求值瞬间同步取用它；若包内
// 自带 .data（full/lite/开发版）则 __asrDataUrl 为空，locateFile 走原 chrome.runtime URL。
const WASM_SCRIPTS = [
  'wasm/sherpa-onnx-wasm-main-asr.js',
  'wasm/sherpa-onnx-asr.js',
  'wasm/sherpa-onnx-punctuation.js',
];

function injectScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL(src);
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`加载 ${src} 失败`));
    document.body.appendChild(s);
  });
}

const asrDataReady = (async () => {
  try {
    const blob = await getModelFile('__asr_wasm_data');
    if (blob && blob.size > 0) (window as any).__asrDataUrl = URL.createObjectURL(blob);
  } catch { /* 无模型也不阻断注入：包内有 .data 的构建照常工作 */ }
  for (const src of WASM_SCRIPTS) await injectScript(src);
})();

let pipeline: Pipeline | null = null;
let port: chrome.runtime.Port;
let reconnectTabId: number | null = null;
let reconnectStreamId: string | null = null;
// 音频来源：'tab'=标签页捕获（tabCapture 签发 streamId）｜'system'=系统音频
// （getDisplayMedia 选择器授权，桌面采集音频环回，见 acquireSystemAudioStream）｜
// 'mic'=麦克风（音频轨在悬浮窗采集，PCM 经 bg 以 MIC_CHUNK 转发进来）。
// INIT 时由 background 随消息带来，贯穿 REQUEST_STREAM/RECONNECT 全链路。
let reconnectSource: 'tab' | 'system' | 'mic' = 'tab';
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

// ---- 实时翻译（离线，worker 内跑 transformers.js）----
// 模型由用户在面板选目录读入 IndexedDB，worker 内重写 fetch 从 IndexedDB 取文件，
// 全程零网络零权限；翻译推理在独立 worker 线程，不阻塞本线程的音频泵/ASR。
//
// —— 调度模型（单 worker 单线程串行 + 优先级队列）——
// worker 每次只跑一条翻译且按提交顺序返回；offscreen 维护"在途 + 待办"两个槽，
// 待办是一个按优先级取任务的队列。优先级（用户指定）：
//   1. FINAL（上一句定稿）——用户体验上最重要：句子说完就该看到完整译文；
//   2. STREAM（当前句实时中间态）——次之，只保留最新一版（旧中间态无意义）；
//   3. BACKLOG（以往句的迟到定稿补译）——最末，但绝不丢弃。
// 旧实现的三个丢译文根因全部由此消除：
//   ① translateFinal 绕过队列直接 postMessage → final 与在途 stream 回包乱序，
//      content 按 seq 路由时定稿被同一句的旧中间态覆盖（"只有后半句"）；
//   ② transPending 只有一个槽，句完成时未翻的中间态直接被置 null 丢弃；
//   ③ 流式译文回包后按代次（epoch）整批作废——句子定稿后中间态不再有意义，
//      但作废动作把"这句还没翻过"的事实也抹掉了，历史/回看里该句永久无译文。
let translateWorker: Worker | null = null;
let translateEnabled = false;
let translateDirection: 'auto' | 'zh-en' | 'en-zh' = 'auto';
// 翻译时机：stream=实时跟句（中间态重译）｜final=仅定稿（句完才翻，最省 CPU）
let translationTiming: 'stream' | 'final' = 'stream';
let translateWarned = false;

// 当前识别句的序号（从 1 起）。随 SENTENCE_DONE 递增，随每次 TRANSLATE 消息带给 worker，
// worker 结果原样回传 → content 据此把译文路由到"当前句行"还是"上一句行"。
let sentenceSeq = 1;

// —— 优先级队列状态 ——
// 在途请求（worker 单线程，同一时刻至多一条）：提交时锁定完整参数，回包后释放并泵队列
let inFlight: {
  kind: 'final' | 'stream';
  seq: number;
  text: string;
} | null = null;
// 各句的最终文本（seq → 定稿原文），backlog 补译时取用；随会话窗口裁剪
const lastFinalTexts = new Map<number, string>();
// 待办队列（数组实现，泵出时按优先级选取；容量受控见 BACKLOG_MAX）
type TransJob = {
  kind: 'final' | 'stream' | 'backlog';
  seq: number;
  text: string;
  at: number; // 入队时刻（诊断用）
};
const transQueue: TransJob[] = [];
// 流式中间态槽：同一句只保留最新一版，泵时作为 STREAM 任务入队
let streamSlot: { text: string; seq: number } | null = null;
// 每句已交付的最好译文（seq → text）。流式译文先到、定稿后到时，定稿覆盖；
// 定稿先到、流式迟到时，迟到的中间态被这里挡住（不覆盖更好的定稿）。
const bestBySeq = new Map<number, string>();
// backlog 上限：极端慢速下最多积压这些句的补译，防内存无界增长。
// 超限时丢最老的——彼时它们已超出"上一句"窗口很远，用户早已滚动过去。
const BACKLOG_MAX = 8;
// 流式冷却：距上次流式提交不足该间隔就不提交新的中间态（定稿/补译不受限）。
// 坑：翻译 worker 满负荷跑长句推理时会和主线程（音频泵/标点推理）争 CPU，
// 无冷却的"每次文本变化都翻"实测把字幕处理链路延迟推到 3s。500ms 是业界
// re-translation 节拍（Google/文献口径）；冷却期内新文本只更新流式槽（合并），
// 到期后翻最新一版——过时的中间态天然被跳过（用户明确要求的语义）。
const STREAM_COOLDOWN_MS = 500;
let transLastStreamAt = 0;
let transCooldownTimer: any = null;

function dropStaleBest() {
  // 只保留活跃窗口内的 seq（当前句 + 上一句 + backlog 窗口），防 Map 无界增长
  const minAlive = sentenceSeq - BACKLOG_MAX - 2;
  for (const k of bestBySeq.keys()) {
    if (k < minAlive) bestBySeq.delete(k);
  }
}

function createTranslateWorker() {
  translateWorker = new Worker(chrome.runtime.getURL('translation-worker.js'));
  translateWorker.onmessage = (e) => {
    const m = (e.data || {}) as any;
    if (m.type !== 'TRANSLATION') return;
    if (m.test) {
      // 测试请求的应答：直接回给测试发起方，不触碰流式/定稿状态机
      finishTranslateTest({ ok: !!m.ok && !!m.text, text: m.text || '', error: m.reason === 'no-model' ? 'no-model' : (m.error || ''), debug: m.debug });
      return;
    }
    // 坑：回包必须与请求对账，防 terminate/重建后旧回包冲状态。但只按 seq 对账——
    // 实测发现 opus-mt 的 tokenizer/生成会对文本做规范化改写（大小写/标点/空格），
    // 按 text 全等比对会让几乎所有回包对不上号而被整体丢弃（表现为一条译文都出不来）。
    // seq 在 worker 是原样回传的，作为对账键足够：串行 worker 下同一 seq 的乱序回包
    // 只可能是同一请求；kind 差异（final↔stream）由 onTranslationResult 按 seq 归位处理。
    if (inFlight && m.seq === inFlight.seq) {
      const done = inFlight;
      inFlight = null;
      if (done.kind === 'stream' && m.kind !== 'stream') {
        // 请求 stream 却回了 final 等异常形态：保守按 stream 语义交付，防覆盖定稿
        onTranslationResult({ kind: 'stream', seq: done.seq, text: done.text }, m);
      } else {
        onTranslationResult(done, m);
      }
    } else if (inFlight) {
      log(`翻译回包对不上号：在途 seq=${inFlight.seq}/${inFlight.kind}，回包 seq=${m.seq}/${m.kind}，丢弃`);
    }
    pumpTranslate();
  };
}

// 一条翻译请求完成：按优先级语义交付结果。
// 交付原则（与队列优先级呼应——"用户此刻最关心的句子"永远拿到最新结果）：
//   - FINAL：定稿译文写 bestBySeq 并立即下发（SENTENCE_DONE 之后 content/bg 都在等它）；
//   - STREAM：中间态译文只在"该句尚未定稿"时下发（seq === sentenceSeq），
//     且绝不覆盖更优的定稿（bestBySeq 里已有该句定稿就静默吞掉）。
//     句子定稿后迟到的中间态不再下发，但 bestBySeq 已有定稿，体验无损；
//     若该句从未拿到定稿（极慢场景被 backlog 兜底），这里保证最终仍有译文落地。
//   - BACKLOG：以往句的补译定稿，写 bestBySeq + 下发（content 按 seq 归位到回看缓冲，
//     bg 按 seq 精确挂历史条目），顺序无所谓——它永远排在更早的句完成之后到达。
function onTranslationResult(job: { kind: 'final' | 'stream'; seq: number; text: string }, m: any) {
  const prev = bestBySeq.get(job.seq);
  if (m.ok && m.text) {
    // FINAL/BACKLOG 视为更优（完整句翻译）；STREAM 只在无任何结果时暂占
    if (job.kind !== 'stream' || prev == null) bestBySeq.set(job.seq, m.text);
    const text = m.text;
    if (job.kind === 'stream') {
      // 中间态只在"这句还没定稿"时值得显示
      if (job.seq === sentenceSeq) sendSafe('FW_CT', { type: 'TRANSLATION', text, seq: job.seq });
    } else {
      // final/backlog 定稿：下发当前显示端 + 历史挂载（bg 按 seq 精确归位）
      sendSafe('FW_CT', { type: 'TRANSLATION_FINAL', text, seq: job.seq });
      sendSafe('FW_POP', { type: 'TRANSLATION_FINAL', text, seq: job.seq });
    }
    log(`[译] 交付 seq=${job.seq}/${job.kind} → "${String(text).slice(0, 30)}"`);
  } else if (m.reason === 'no-model' && !translateWarned) {
    translateWarned = true;
    log('翻译不可用：未检测到翻译模型。请在扩展面板"实时翻译"中点击"选择模型"安装官方模型包（github.com/huchangzhi/easysub/releases）');
  } else if (m.error && !translateWarned) {
    translateWarned = true;
    log('翻译出错: ' + m.error);
  }
  if (prev == null && !m.ok) bestBySeq.delete(job.seq); // 失败不留占位
  dropStaleBest();
}

// —— 队列泵：worker 空闲时按优先级取下一个任务 ——
// 选取顺序：final（1）> stream（2）> backlog（3）；同优先级按入队先后（FIFO）。
// final 入队时天然只有一个（同一时刻只有"刚完成句"需要定稿），backlog 保序即可。
// 坑：必须在"置 inFlight 之后"才 postMessage，且泵函数自身幂等（inFlight 非空即退），
// 防止 onmessage 与 enqueue 并发重入造成双发。
function pumpTranslate() {
  if (!translateWorker || !translateEnabled || inFlight) return;
  // 优先级 1+2：final / stream（先入先出）；backlog 只在两者皆无时取最老的。
  // 注意 stream 任务在提交时作废流式槽：槽里更新的中间态会在下次泵时重新成为任务，
  // 保证"翻出去的版本不早于提交瞬间屏上的文本"，且同一时刻至多一条 stream 在途。
  let job: TransJob | null = null;
  let idx = -1;
  for (let i = 0; i < transQueue.length; i++) {
    const j = transQueue[i];
    if (j.kind === 'final' || j.kind === 'stream') { job = j; idx = i; break; }
  }
  if (!job) {
    for (let i = 0; i < transQueue.length; i++) {
      if (transQueue[i].kind === 'backlog') { job = transQueue[i]; idx = i; break; }
    }
  }
  if (!job) {
    // 队列空：若流式槽有货，把最新中间态转成 STREAM 任务（合并语义：只翻最新版）
    if (streamSlot && translationTiming === 'stream') {
      job = { kind: 'stream', seq: streamSlot.seq, text: streamSlot.text, at: Date.now() };
      streamSlot = null;
    } else return;
  } else if (job.kind === 'stream') {
    streamSlot = null;
  }
  if (idx >= 0) transQueue.splice(idx, 1);
  if (job.kind === 'stream') transLastStreamAt = Date.now(); // 流式冷却计时起点
  inFlight = { kind: job.kind === 'backlog' ? 'final' : job.kind, seq: job.seq, text: job.text };
  log(`[译] 提交 seq=${job.seq}/${job.kind} "${job.text.slice(0, 24)}" 队列余=${transQueue.length}${streamSlot ? ' 槽有货' : ''}`);
  translateWorker.postMessage({
    type: 'TRANSLATE',
    text: job.text,
    seq: job.seq,
    direction: translateDirection,
    // backlog 按定稿（kind:'final'）发给 worker：补译结果走 TRANSLATION_FINAL 通道
    kind: job.kind === 'backlog' ? 'final' : job.kind,
    wasmPaths: chrome.runtime.getURL('ort-wasm/'),
  });
}

function ensureTranslateWorker() {
  if (translateWorker || !translateEnabled) return;
  try {
    createTranslateWorker();
  } catch (e) {
    log('翻译 worker 创建失败: ' + e);
  }
}

// —— 翻译模型自测：面板"测试翻译"经 background → offscreen → worker 的一次性请求 ——
let translateTestResolver: ((r: { ok: boolean; text?: string; error?: string; debug?: any }) => void) | null = null;
let translateTestTimer: any = null;
let testOwnedWorker = false; // 测试时临时创建的 worker（无会话翻译共用）→ 取消时可直接 terminate

function finishTranslateTest(r: { ok: boolean; text?: string; error?: string; debug?: any }) {
  if (translateTestTimer) { clearTimeout(translateTestTimer); translateTestTimer = null; }
  if (translateTestResolver) {
    const cb = translateTestResolver;
    translateTestResolver = null;
    cb(r);
  }
}

function cancelTranslateTest() {
  if (testOwnedWorker && translateWorker) {
    resetTranslationState();
    translateWorker.terminate();
    translateWorker = null;
  }
  finishTranslateTest({ ok: false, error: 'cancelled' });
}

function testTranslate(text: string, direction: string): Promise<{ ok: boolean; text?: string; error?: string; debug?: any }> {
  return new Promise((resolve) => {
    // 测试不依赖"启用翻译"开关：翻译未启用也创建 worker 实测（模型加载失败会因记忆化只跑一次）
    if (!translateWorker) {
      try {
        createTranslateWorker();
        testOwnedWorker = true;
      } catch (e) {
        resolve({ ok: false, error: 'worker-create-fail' });
        return;
      }
    }
    translateTestResolver = resolve;
    // 测试用 24 个 token 上限：短句足够验证模型可用，避免单线程生成跑满 128 token 久久不返回
    translateWorker!.postMessage({ type: 'TRANSLATE', text, direction, kind: 'final', wasmPaths: chrome.runtime.getURL('ort-wasm/'), test: true, maxNewTokens: 24 });
    translateTestTimer = setTimeout(() => finishTranslateTest({ ok: false, error: 'timeout' }), 120000);
  });
}

// —— 翻译状态整体复位：会话停止 / 测试取消 / worker 重建时调用，防上一场任务串场 ——
function resetTranslationState() {
  inFlight = null;
  transQueue.length = 0;
  streamSlot = null;
  bestBySeq.clear();
  lastFinalTexts.clear();
  if (transCooldownTimer) { clearTimeout(transCooldownTimer); transCooldownTimer = null; }
  transLastStreamAt = 0;
  sentenceSeq = 1;
}

function destroyTranslateWorker() {
  resetTranslationState();
  translateWorker?.terminate();
  translateWorker = null;
  translateWarned = false;
}

// 流式：识别文本变化即更新"当前句中间态"槽（同一文本不重复翻）。
// 槽是合并语义：冷却未翻的旧版本自然被最新版覆盖，绝不堆积、也绝不丢失——
// 丢失的只是"无意义的旧中间态"，最新文本永远会经队列翻译。
// translateWarned 置位后（模型缺失或加载失败已确诊）不再发送，避免每句/每次变化徒劳触发 worker。
// 坑：ASR 输出全大写，标点模型对英文句也常给中文全角标点——这种"全大写+中文标点"
// 形态远超出翻译模型的训练分布，质量掉得厉害。翻译前规范化：全角标点→半角，英文
// 按句转"句首大写其余小写"（中文句子无大小写概念，原样放行）。
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;
// 句子边界：半角/全角句号问号叹号后跟空白（标点归属前一句，保留原样不断章取义）
function sentenceCase(text: string): string {
  return text.split(/(?<=[.!?。！？])\s+/).map((sentence) => {
    if (CJK_RE.test(sentence)) return sentence;
    const mi = sentence.search(/[A-Za-z]/);
    if (mi === -1) return sentence;
    const head = sentence.slice(0, mi);
    const rest = sentence.slice(mi);
    return head + rest.charAt(0).toUpperCase() + rest.slice(1).toLowerCase().replace(/(^|\s)i(\s|$)/g, '$1I$2');
  }).join(' ');
}
// 显示用：只去全大写，保留标点模型打的中文标点断句
function displayCase(text: string): string {
  return sentenceCase(text);
}
function normalizeForTranslate(text: string): string {
  const full = /[\uFF0C\u3002\uFF1F\uFF01\uFF1B\uFF1A\u201C\u201D\u2018\u2019\uFF08\uFF09\u3010\u3011]/;
  const half = { '\uFF0C': ',', '\u3002': '.', '\uFF1F': '?', '\uFF01': '!', '\uFF1B': ';', '\uFF1A': ':', '\u201C': '"', '\u201D': '"', '\u2018': "'", '\u2019': "'", '\uFF08': '(', '\uFF09': ')', '\u3010': '[', '\u3011': ']' } as Record<string, string>;
  const t = text.replace(full, (ch) => half[ch] ?? ch);
  return sentenceCase(t);
}

function translateStream(text: string) {
  // 仅定稿模式：中间态不翻译，译文只随 SENTENCE_DONE 出
  if (translationTiming === 'final') return;
  if (!translateEnabled || !translateWorker || translateWarned || !text) return;
  text = normalizeForTranslate(text);
  // 与在途/已入队的最新中间态相同则跳过（去重，不丢新内容）
  if (inFlight?.kind === 'stream' && inFlight.seq === sentenceSeq && inFlight.text === text) return;
  if (streamSlot && streamSlot.seq === sentenceSeq && streamSlot.text === text) return;
  // 流式冷却：间隔不足时只刷新槽（新文本自然覆盖旧文本=过时版本被跳过），
  // 由到期定时器重入泵。注意冷却只挡 stream——final/backlog 不受限，
  // 句子定稿的译文绝不因冷却而延迟。
  const wait = STREAM_COOLDOWN_MS - (Date.now() - transLastStreamAt);
  streamSlot = { text, seq: sentenceSeq };
  if (wait > 0) {
    if (!transCooldownTimer) {
      transCooldownTimer = setTimeout(() => {
        transCooldownTimer = null;
        pumpTranslate();
      }, wait);
    }
    return;
  }
  pumpTranslate();
}

// 定稿：句子结束翻一次并记录。
// 坑（本分支核心修复）：旧实现绕过队列直接 postMessage，与在途流式请求的回包乱序，
// content 按 seq 路由时定稿被同一句迟到半截的中间态覆盖（"翻译只有后半句"的直接根因）。
// 现在定稿只是"最高优先级入队"：在途的中间态跑完后，worker 下一条立即翻本定稿；
// 同时该句积压的流式任务全部作废（完整定稿一出，半截中间态全无意义）。
// seq 取"刚完成句"的序号：调用点（onSentenceDone）在递增 sentenceSeq 之前执行。
function translateFinal(text: string) {
  if (!translateEnabled || !translateWorker || translateWarned || !text) return;
  const seq = sentenceSeq;
  // 作废该句残留的流式任务：队列里的 STREAM 中间态 + 未提交的流式槽。
  // 注意不能动其它句的 backlog 任务（那是丢译文的旧病根）。
  for (let i = transQueue.length - 1; i >= 0; i--) {
    if (transQueue[i].kind === 'stream' && transQueue[i].seq === seq) transQueue.splice(i, 1);
  }
  if (streamSlot && streamSlot.seq === seq) streamSlot = null;
  // 该句的在途流式请求已经没有意义（马上会被同一 seq 的定稿覆盖），作废对账：
  // 回包到达时 seq 相同但请求已按 final 记账——这里直接清掉，让定稿任务顶上。
  if (inFlight && inFlight.kind === 'stream' && inFlight.seq === seq) {
    inFlight = null;
    // 作废在途后立即补翻该句定稿：绝不等"回包空转一圈"
  }
  const finalText = normalizeForTranslate(text);
  transQueue.push({ kind: 'final', seq, text: finalText, at: Date.now() });
  pumpTranslate();
  log(`[译] final 入队 seq=${seq} 队列=${transQueue.length} 在途=${inFlight ? inFlight.kind + '#' + inFlight.seq : '无'}`);
}

// 以往句补译：上一句定稿尚未交付（worker 被"上一句"之外的占用拖住）时，
// 新句完成把"再上一句"的定稿挤成 backlog——按用户指定的最低优先级排队，
// 任何慢速场景下以往句的译文都只会迟到、绝不丢失。
// text 应传"该句的最终文本"（调用点持有序号与文本的配对）。
function translateBacklog(seq: number, text: string) {
  if (!translateEnabled || !translateWorker || translateWarned || !text) return;
  // 已有更优结果（流式已交付过该句译文）则只升级不下发重复
  if (bestBySeq.get(seq) === normalizeForTranslate(text)) return;
  // 同句去重：队列里已有该句的补译就覆盖文本（保留最早的优先位置）
  const existing = transQueue.find(j => j.seq === seq && j.kind === 'backlog');
  if (existing) { existing.text = normalizeForTranslate(text); return; }
  transQueue.push({ kind: 'backlog', seq, text: normalizeForTranslate(text), at: Date.now() });
  // backlog 容量钳制：丢最老（seq 最小）的超出部分
  const bl = transQueue.filter(j => j.kind === 'backlog').sort((a, b) => a.seq - b.seq);
  if (bl.length > BACKLOG_MAX) {
    const victim = bl[0];
    const vi = transQueue.indexOf(victim);
    if (vi >= 0) transQueue.splice(vi, 1);
  }
  pumpTranslate();
}

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

// ---- 音频电平测量（LEVEL 测量端，经 FW_POP 发送 { type:'LEVEL', v }）----
// 口径：复用现有 60ms flush 回包路径的音频帧计算 RMS，经"慢攻击快释放"包络平滑后
// 归一化到 [0,1]：
//   - 攻击（上升）系数 0.2：读数缓慢爬升，语音突发不会让指示器刺眼跳变；
//   - 释放（下降）系数 0.6：转静音时快速回落，指示不拖尾。
// 归一化：rms×4 后截断到 [0,1]——正常语音块 RMS 约 0.05~0.25，×4 落在量程中上部；
// 纯固定增益、无 AGC，极轻/极响音源可能偏低或顶格，属预期行为。
// 静音：不做底噪抑制特判——数字采集的本底 RMS≈0，包络会自然趋 0。
// 开销：每 60ms 块一次 O(n) 乘加累加（≈2880 样本，复用局部标量累加变量）+ 几次标量
// 运算，无逐帧对象分配、无新增定时器，帧数据来自既有 flush 消息、零额外采集成本。
let levelEnv = 0;
let lastLevelSentAt = 0;

function recordLevel(buf: Float32Array) {
  let sumSq = 0;
  for (let i = 0; i < buf.length; i++) sumSq += buf[i] * buf[i];
  const rms = Math.sqrt(sumSq / Math.max(1, buf.length));
  const target = Math.min(1, rms * 4);
  // 坑：攻击/释放不对称是刻意的——对称平滑会在语音起音时明显滞后、静音时又拖尾；
  // 两个系数作用于同一条标量包络，不引入额外状态。
  levelEnv = target > levelEnv ? levelEnv * 0.8 + target * 0.2 : levelEnv * 0.4 + target * 0.6;
  // 节流坑：≥120ms 一条（约 8 条/秒足够指示器流畅）；先查节流窗口再决定是否序列化发送，
  // 不满足直接返回，避免每 60ms 都走一遍消息开销。
  if (Date.now() - lastLevelSentAt < 120) return;
  // 仅 pipeline Running 时发送；STOP/INIT 后 pipeline 为 null 或非 Running 自然停发，
  // 且两端都会把包络归零（见 INIT/STOP 处理器），显示端按消息缺失自行清零显示。
  if (!pipeline || pipeline.getStatus() !== JobStatus.Running) return;
  lastLevelSentAt = Date.now();
  sendSafe('FW_POP', { type: 'LEVEL', v: Math.round(levelEnv * 100) / 100 });
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

// 坑：该 wasm 构建没编 getExceptionMessage，C++ throw 会变成 emscripten 抛出的裸指针
// （__cxa_exception 对象地址，就是个数字）。按 libc++/emscripten 布局手动解码：
//   excPtr 指向异常对象的开头；-20 处是 typeinfo*；对象体是 { vptr, std::string }，
//   with 字段是 libc++ long-mode std::string（首 4 字节即字符串堆指针）。
async function describeWasmException(e: any): Promise<string> {
  if (typeof e !== 'number') return String(e);
  try {
    const M = (window as any).Module;
    const read32 = (p: number) => M.HEAPU32[p >> 2];
    const typeinfo = read32(e - 20);
    const type = typeinfo ? M.UTF8ToString(read32(typeinfo + 4)) : '(no typeinfo)';
    let msg = '';
    for (const off of [4, 8, 12, 16]) {
      const w = read32(e + off);
      if (w > 0 && w < M.HEAPU8.length) {
        const s = M.UTF8ToString(w);
        if (s) { msg = s; break; }
      }
    }
    if (!msg) {
      const b: number[] = [];
      let i = 0;
      while (i < 128) {
        const c = M.HEAPU8[e + 4 + i];
        if (!c) break;
        b.push(c); i++;
      }
      msg = String.fromCharCode(...b);
    }
    return `WASM C++ 异常: ${type} | ${msg || '(无消息)'}`;
  } catch (err) {
    return `WASM 异常指针 ${e}（解码失败: ${err}）`;
  }
}

function sendSafe(type: string, payload: any) {
  try { port.postMessage({ type, payload }); } catch {}
}

// 状态文案（"正在加载模型" / "正在等待音频" / "请选择要共享的屏幕"）走**独立通道**，
// 不再借用 TEXT_CHANGED。坑：借字幕通道有三个坏处——
//   ① 状态串被当成一句字幕写进字幕行，用户会看到"正在等待音频"作为字幕出现；
//   ② 发送点与真实阶段脱钩。旧实现在流程的固定位置无条件发 waiting，不看音源、
//      不看模型是否已就绪，于是"模型还在加载"时提示已经跳到"正在等待音频"（提示错乱）；
//   ③ mic/system 模式下音频根本不由本方法获取，却同样收到"正在等待音频"。
// 各音源的真实阶段顺序并不统一（tab：先加载模型后取权限；system/mic：先取权限后加载
// 模型，见 INIT_OFFSCREEN 里 system 分支的注释），所以不做统一封装，
// 由每个分支在**自己的真实转换点**调用。key 为空表示清除状态文案。
function sendStatus(key: string) {
  const payload = { type: 'STATUS_TEXT', key };
  // 两个显示端各一条：FW_CT → 页面叠层 / 悬浮字幕窗；FW_POP → 面板状态栏。
  // 面板侧落到 modelStatus，不再像旧实现那样被当成"当前字幕"塞进预览区。
  sendSafe('FW_CT', payload);
  sendSafe('FW_POP', payload);
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
  // tab 模式：tabCapture 在 SW 侧签发 streamId，这里消费。system 模式不走此函数
  // （无 streamId 可用，见 acquireSystemAudioStream）。
  const constraints: any = {
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
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
  await pipeCaptureStream(stream, 'tab');
}

// 坑：会话代次。INIT/STOP 各递增一次，用于作废在途的异步初始化：
// system 模式下权限弹窗与模型加载之间可能隔着任意长的用户操作时间，
// 期间会话若被停止或重启，旧闭包不得再把音频接进新会话。
let sessionEpoch = 0;

// 系统音频（整机环回）：MV3 的 desktopCapture 两条路都被 Chrome 堵死——SW 里调用
// 强制要求 targetTab（crbug 41493089），其 streamId 又官方确认无法在 offscreen 文档
// 消费（crbug 326509126）。唯一可行组合就是 offscreen 文档内直接 getDisplayMedia：
// 选择器本身即授权（用户勾「分享系统音频」），无 OS 级权限弹窗、无 streamId 传递。
// 只取音频轨返回，不接管道——调用方决定何时开始喂音频。
async function acquireSystemAudioStream(): Promise<MediaStream> {
  const media = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  // 只要音频轨；视频轨停掉——系统环回音频独立于屏幕画面，停视频不影响。
  media.getVideoTracks().forEach((t) => t.stop());
  const audio = media.getAudioTracks()[0];
  if (!audio) throw new Error('未获取到系统音频轨道');
  return new MediaStream([audio]);
}

// 麦克风：Chrome 禁止 offscreen 文档做 getUserMedia 音频采集（NotAllowedError），
// 音频轨由悬浮字幕窗（可见扩展页）采集，PCM 块经 bg 以 MIC_CHUNK 转发进来直接喂管道。

async function pipeCaptureStream(stream: MediaStream, source: 'tab' | 'system' | 'mic') {
  // 坑：换流前必须先释放上一份采集。INIT_OFFSCREEN 有两条投递路径（bg 的
  // checkPendingInit 与直投），同一次启动可能触发两次，两条 async 链会各自走到这里 ——
  // 不先停机就会出现两个 AudioContext 并存：旧的从不 close（Chrome 单文档 AudioContext
  // 有数量上限，反复重连后 new AudioContext() 直接抛错、会话再也起不来），旧 worklet 的
  // 输入仍连着、process() 仍被调用，但它的 flush 定时器已被覆盖清除 —— 缓冲只进不出，
  // 约 192KB/s 无上限增长，长会话必 OOM。stopAudio() 一次性收敛 ctx/worklet/定时器/
  // audioEl/旧 track，是这里唯一正确的顺序。
  stopAudio();
  captureStream = stream;
  // 坑：此前完全没有 track ended 检测。system 模式用户点"停止共享"、被捕获标签页被关闭、
  // 音频设备拔出时，MediaStreamAudioSourceNode 只会输出静音 —— worklet 照常送全零帧，
  // pipeline 保持 Running，界面"正常"但永远不会再出字幕，且没有任何错误提示
  // （用户最难自查的一类卡死）。监听 ended 后统一上报 ERROR，
  // 由 background 走 cleanupAll 收敛成一次可见的停止。
  stream.getTracks().forEach((track) => {
    // 注意：自己调 track.stop() 不会触发本事件，所以上面的 stopAudio() 不会误报。
    track.addEventListener('ended', () => {
      if (captureStream !== stream) return; // 已被更新的流替换（重连），忽略旧流的 ended
      log('音频轨道已结束，上报停止');
      sendSafe('FW_POP', { type: 'ERROR', message: tSync(currentLang, 'sourceEnded') });
    });
  });
  // 坑：tab 模式必须建 <audio> 回放——被捕获标签页的声音经捕获流转发，不回放就是静音；
  // system 模式是系统环回（loopback），原声照常出扬声器，回放反而造成回声，绝不能开；
  // mic 模式同理——回放麦克风=外放回声啸叫，也绝不能开。
  if (source === 'tab') {
    audioEl = document.createElement('audio');
    audioEl.srcObject = stream;
    audioEl.play().catch(() => {});
  }

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
  const ctx = new AudioContext();
  audioCtx = ctx;
  const source = ctx.createMediaStreamSource(stream);
  const url = chrome.runtime.getURL('audio-worklet-processor.js');
  // ponytail: audioWorklet.addModule 必须用扩展 URL（blob 被 CSP 'self' 拦截）
  await ctx.audioWorklet.addModule(url);
  // 坑：await 之后必须核对 audioCtx 是否仍是自己。await 期间可能已有更新的一次初始化
  // 接管（见 pipeCaptureStream 开头关于重复初始化的说明）；继续往下就会在"已不是当前"
  // 的 ctx 上建节点，而旧 ctx 无人 close —— AudioContext 泄漏 + 缓冲永不排空。
  if (audioCtx !== ctx) { ctx.close().catch(() => {}); return; }

  const node = new AudioWorkletNode(ctx, 'audio-buffer');
  workletNode = node;
  source.connect(node);
  // 坑：AudioWorkletNode 在"只有上游连接、自身不接下游"时 process() 是否仍被渲染图拉取，
  // 依赖实现与版本细节（降级路径的 ScriptProcessorNode 就明确要求被下游拉取）。用 gain=0
  // 桥接到 destination：链路保持活跃且完全静音，消除版本差异导致的
  // "process() 不被调用 → 无音频、无字幕、无报错"这类静默故障。零成本，故无条件桥接。
  const muteGain = ctx.createGain();
  muteGain.gain.value = 0;
  node.connect(muteGain);
  muteGain.connect(ctx.destination);

  // 坑：offscreen 文档冷启动时可能没有用户激活，AudioContext 会以 suspended 启动；此时
  // 渲染图不推进、worklet 永不回包 —— 同样是"无音频、无字幕、无报错，界面停在运行中"。
  // 降级路径一直有 resume()，worklet 路径此前漏了。运行中被系统挂起（休眠、音频设备切换）
  // 是同一类故障，所以 statechange 一并监听，把它变成一条用户可见的错误。
  let everRunning = false;
  ctx.onstatechange = () => {
    if (audioCtx !== ctx) return;
    log('AudioContext 状态: ' + ctx.state);
    if (ctx.state === 'running') { everRunning = true; return; }
    // 只在"确实跑起来过"之后把挂起当故障上报：初始 suspended 由下面的分支统一处理，
    // 否则同一次启动会连报两条错误。
    if (everRunning) {
      everRunning = false;
      sendSafe('FW_POP', { type: 'ERROR', message: `音频输出被系统挂起（${ctx.state}），识别已停止` });
    }
  };
  if (ctx.state !== 'running') {
    try { await ctx.resume(); } catch (e) { log('AudioContext resume 失败: ' + e); }
  }
  if (audioCtx !== ctx) { ctx.close().catch(() => {}); return; }
  if (ctx.state !== 'running') {
    log('AudioContext 未能进入 running: ' + ctx.state);
    sendSafe('FW_POP', { type: 'ERROR', message: `音频输出未启动（AudioContext ${ctx.state}），请重新开始识别` });
    return;
  }

  node.port.onmessage = (e: MessageEvent) => {
    // 坑：旧采集链的迟到回包必须丢弃。否则被接管后旧 worklet 仍会把音频喂给当前
    // pipeline（两份音频交错），表现为识别结果抖动/串音。
    if (audioCtx !== ctx) return;
    if (e.data && e.data.audio) {
      const buf = new Float32Array(e.data.audio);
      if (buf.length > 0) {
        // 电平测量直接用本块帧数据算 RMS，必须在 feedAudio 之前（feedAudio 不改 buf，
        // 但保持"测量先于消费"的顺序可读性更好）；开销口径见 recordLevel 注释。
        recordLevel(buf);
        // 坑：采样率取本地 ctx 而不是模块级 audioCtx!——后者在停机/接管后为 null，
        // 会在迟到回包里抛未捕获 TypeError。
        const sr = e.data.sampleRate || ctx.sampleRate;
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
      // 坑：本定时器链必须能自杀。stopAudio() 会 clearTimeout 停掉当前链，但若期间已有
      // 更新的一次初始化接管（audioCtx 换人），这条旧链会被自己重新续上，导致两个 60ms
      // 循环向同一节点重复发 flush（音频被切成碎片块）。每轮先核对代次再续。
      if (audioCtx !== ctx) return;
      // 记录 flush 发出时刻供延迟测量使用（复用现有 60ms 路径，不新增定时器）。
      // 若上一轮回包因主线程阻塞迟到，此值被覆盖后 RTT 按最新发送计时——低估近似，可接受。
      lastFlushSentAt = performance.now();
      node.port.postMessage('flush');
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
    // 降级路径同样复用帧数据测电平，保证降级时指示器不冻结（口径见 recordLevel 注释）。
    recordLevel(buf);
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
  const myPort = chrome.runtime.connect({ name: 'offscreen' });
  port = myPort;

  myPort.onDisconnect.addListener(() => {
    console.log('[TM Offscreen] 端口断开');
    const wasRunning = !!pipeline;
    if (wasRunning) console.log('[TM Offscreen] 管道还在运行，1 秒后重连...');
    setTimeout(() => {
      // 竞态守卫：期间若已建立更新的端口（另一次重连已成功），不重复建连。
      if (port !== myPort) return;
      // 无条件重连：运行中 SW 被回收断开时，重连 + RECONNECT 让 background 自愈会话状态；
      // 停止时 background 会立刻销毁本文档，这段代码大概率没机会执行——即便在销毁完成前
      // 抢跑重连一次，也只是空连一秒后随文档一起消亡，无副作用。
      setupPort();
      if (wasRunning) {
        sendSafe('FW_POP', { type: 'RECONNECT', tabId: reconnectTabId, streamId: reconnectStreamId, source: reconnectSource, status: 'Running' });
      }
    }, 1000);
  });

  myPort.onMessage.addListener((msg) => {
    try {
    if (msg.type === 'INIT_OFFSCREEN') {
      // ponytail: INIT_OFFSCREEN 可能触发两次（重连），__recognizer/__punctuator 只创建一次
      // ponytail: WASM 无法二次加载模型，重建 recognizer 需重启整个 offscreen 文档
      log('收到 INIT_OFFSCREEN');
      sessionEpoch++;
      const epoch = sessionEpoch;
      reconnectTabId = msg.tabId || null;
      reconnectStreamId = msg.streamId || null;
      reconnectSource = msg.source === 'system' ? 'system' : msg.source === 'mic' ? 'mic' : 'tab';
      if (msg.lang) currentLang = msg.lang;
      usePunct = msg.usePunct !== false;

      stopAudio();
      pipeline?.stop();
      pipeline = null;

      // 翻译开关/方向由 background 在 INIT 时从 storage 读出随消息带来
      // （offscreen 文档无 chrome.storage 访问权，只能靠 bg 转发）；下次启动会话时生效。
      translateEnabled = msg.translationEnabled === true;
      translateDirection = msg.translationDirection === 'zh-en' || msg.translationDirection === 'en-zh'
        ? msg.translationDirection : 'auto';
      translationTiming = msg.translationTiming === 'final' ? 'final' : 'stream';
      if (translateEnabled) ensureTranslateWorker();
      resetTranslationState();

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
      // 电平包络同步归零，防止新会话开头指示器从上一场的残留电平起步。
      levelEnv = 0;
      lastLevelSentAt = 0;

      pipeline = new Pipeline({
        onTextChanged: (text) => {
          lastText = text;
          if (usePunct) {
            const display = displayCase(lastPunctText || text);
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
                lastPunctText = displayCase(addPunctuation(lastText));
                sendSafe('FW_CT', { type: 'OVERLAY_TEXT', prev: prevSentence, current: lastPunctText })
                sendSafe('FW_CT', { type: 'TEXT_CHANGED', text: lastPunctText })
                sendSafe('FW_POP', { type: 'TEXT_CHANGED', text: lastPunctText })
              }, 0);
            }
          } else {
            const display = displayCase(text);
            sendSafe('FW_CT', { type: 'OVERLAY_TEXT', prev: prevSentence, current: display })
            sendSafe('FW_CT', { type: 'TEXT_CHANGED', text: display })
            sendSafe('FW_POP', { type: 'TEXT_CHANGED', text: display })
          }
          translateStream(text);
        },
        onSentenceDone: (text) => {
          // ponytail: addPunctuation 同步调 CT-Transformer 模型推理，会阻塞主线程
          // AudioWorklet 在音频线程持续缓冲，解阻塞后 pipeline 处理积压帧
          prevSentence = usePunct ? displayCase(addPunctuation(text)) : displayCase(text);
          lastText = '';
          lastPunctText = '';
          // 句序号：本句的序号（尚未递增），随后递增给下一句；content 据此路由译文归属
          const seq = sentenceSeq;
          // 坑（丢译文修复）：上一句（seq-1）若已有流式译文但定稿任务还没轮到跑，
          // 旧实现会因"中间态过期"把它整个丢掉，且不再补翻——该句译文永久丢失。
          // 现在把它的"最终文本"以最低优先级（backlog）排队补翻：worker 空出来时
          // 会拿到完整定稿译文下发，历史/回看按 seq 精确归位。若上一句从未有过
          // 任何译文（bestBySeq 无记录），同样入队——这才是"记录丢句子"的兜底。
          // 已翻过定稿（bestBySeq 有记录）则跳过，不浪费推理。
          if (seq - 1 >= 1 && !bestBySeq.has(seq - 1)) {
            const prevFinal = lastFinalTexts.get(seq - 1);
            if (prevFinal) translateBacklog(seq - 1, prevFinal);
          }
          // 记录本句最终文本：其定稿译文若被后续句子挤出，backlog 补译要靠它取文本
          lastFinalTexts.set(seq, prevSentence);
          for (const k of lastFinalTexts.keys()) {
            if (k < seq - BACKLOG_MAX - 2) lastFinalTexts.delete(k);
          }
          sendSafe('FW_CT', { type: 'OVERLAY_TEXT', prev: prevSentence, current: '' });
          sendSafe('FW_CT', { type: 'SENTENCE_DONE', text: prevSentence, isFinal: true, seq });
          sendSafe('FW_POP', { type: 'SENTENCE_DONE', text: prevSentence, seq });
          translateFinal(prevSentence);
          sentenceSeq = seq + 1;
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
        // system 模式：先弹 getDisplayMedia 选择器拿权限、拿到音频，再加载模型。
        // 旧顺序是模型就绪后才弹窗，用户对着"已运行却没字幕"干等模型加载完才见弹窗，
        // 割裂难用；取消选择时还会白白加载一遍模型。tab 模式不动：streamId 有效期短，
        // 必须模型就绪后现签现用（见下方注释），无法提前。mic 模式音频从悬浮窗经
        // MIC_CHUNK 流入，本文档无需预拿。
        let preStream: MediaStream | null = null;
        // 模型是否真的要加载。文档是全新加载时 __wasmReady/__recognizer/__punctuator 均不存在；
        // 崩溃残留文档被复用时它们可能已在——这时不能再提示"正在加载模型"，
        // 否则提示与真实状态无关，又是错乱来源。
        const needLoadModel = !(window as any).__wasmReady
          || !(window as any).__recognizer
          || (usePunct && !(window as any).__punctuator);
        if (reconnectSource === 'system') {
          // system 先要权限：此刻既没在加载模型、也还没到"等音频"，两个旧文案都不对，
          // 必须单列一条"请选择要共享的屏幕"，否则用户对着"正在加载模型"干等弹窗。
          sendStatus('pickingScreen');
          try {
            preStream = await acquireSystemAudioStream();
          } catch (e: any) {
            log('系统音频捕获失败或已取消: ' + (e?.message || e));
            // 用户关掉选择器：NotAllowedError/AbortError 都算主动取消，报统一文案
            const cancelled = e?.name === 'NotAllowedError' || e?.name === 'AbortError';
            sendSafe('FW_POP', {
              type: 'ERROR',
              message: cancelled ? tSync(currentLang, 'pickerCancelled') : `系统音频捕获失败: ${e?.message || e}`,
            });
            // 采集根本没起来，bg/popup 留在 Running 就是幽灵会话：令 bg 走统一清理
            // （关 offscreen 文档与悬浮窗、状态落定 Stopped）。tab 模式无此需要——
            // 它的失败由 handleRequestStream 的 catch 负责 cleanupAll。
            sendSafe('FW_STOP', {});
            return;
          }
          // 授权期间会话已被停止/重启：把刚拿到的轨道关掉，作废本闭包
          if (epoch !== sessionEpoch) {
            preStream.getTracks().forEach((t) => t.stop());
            return;
          }
        }
        // 真正开始加载模型时才提示。tab 走到这里才开始要权限（"先加载后取权限"），
        // system/mic 的权限已在上一步拿到（"先取权限后加载"）——顺序不同，提示点也不同。
        if (needLoadModel) sendStatus('loadingModel');
        await waitForWasm();
        if (!(window as any).__recognizer) {
          const r1 = msg.endpointRule1 ?? 0.8;
          const r2 = msg.endpointRule2 ?? 0.6;
          const r3 = msg.endpointRule3 ?? 15;
          const recCfg: any = {
            rule1MinTrailingSilence: r1,
            rule2MinTrailingSilence: r2,
            rule3MinUtteranceLength: Math.round(r3),
          };
          // 热词：仅当非空才切 modified_beam_search 并烘焙 hotwordsBuf（wasm 一次性
          // 嵌入配置，无 per-stream 热更新；空列表完全不改默认 greedy 行为）。
          // ponytail: 中文术语偏置最好，英文是字符级偏置、效果略弱
          if (Array.isArray(msg.hotwords) && msg.hotwords.length) {
            // 坑：: # @ 是 sherpa 热词保留语法前缀，@ 会 std::stof 抛异常导致
            // recognizer 创建崩溃（C++ std::invalid_argument 以裸指针形式透出），
            // 这里直接丢弃这类 token。
            const buf = (msg.hotwords as string[])
              .filter((w) => !!w.trim() && !/^[:#@]/.test(w.trim()))
              .map((w) => w.trim())
              .join(' ');
            if (buf) {
              recCfg.decodingMethod = 'modified_beam_search';
              recCfg.hotwordsBuf = buf;
              recCfg.hotwordsBufSize = new TextEncoder().encode(buf).length;
              recCfg.hotwordsScore = 1.5;
            }
          }
          // 坑：模型是逐字词表（cjkchar），英文整词查不到 ID 时 wasm 会为每个失败词刷屏
          // 打日志（"Cannot find ID for token"）——大表里几个英文词就能灌爆 console 卡死
          // 面板。建 recognizer 期间临时静默这两类纯 init 噪音，不影响真实错误输出。
          const origErr = console.error;
          const origLog = console.log;
          const swallow = (...a: unknown[]) => {
            const s = String(a[0] ?? '');
            if (s.includes('Cannot find ID for token') || s.includes('Failed to encode some hotwords')) return;
            origErr(...a);
          };
          console.error = swallow as typeof console.error;
          console.log = swallow as typeof console.log;
          try {
            (window as any).__recognizer = createOnlineRecognizer((window as any).Module, recCfg);
          } finally {
            console.error = origErr;
            console.log = origLog;
          }
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
        // 模型加载期间会话被停止/重启：作废本闭包，不再触碰 pipeline。
        // preStream 必须一并释放，否则拿到的系统音频轨会一直挂着（麦克风/屏幕共享指示灯不灭）。
        if (epoch !== sessionEpoch) {
          preStream?.getTracks().forEach((t) => t.stop());
          return;
        }
        // 模型就绪后进入"取音频"阶段，但三种音源要的东西不同，提示不能一刀切：
        //   tab    → 等 streamId 签发 + getUserMedia 开流（下面 REQUEST_STREAM），确实在等音频；
        //   mic    → 等悬浮窗把 PCM 推起来，确实在等音频；
        //   system → 音频在授权阶段就已在手，这里只是接入管道，再提示"正在等待音频"就是假的，
        //            清掉上一条提示即可（随后就该出字了）。
        sendStatus(reconnectSource === 'system' ? '' : 'waiting');
        await pipeline!.start();
        // 坑：capture streamId 有效期很短，必须在消费前一刻才签发。此刻 WASM/模型已就绪，
        // 向 background 要一个全新的 streamId 并立即开流。旧实现"启动时预签发、
        // 模型加载完才消费"，时间窗一长就会报 "Error starting tab capture"。
        // system 模式没有 streamId 可用（desktopCapture 无法跨进 offscreen，见
        // acquireSystemAudioStream 注释）：授权阶段已拿到音频，此刻直接接入管道开喂。
        if (reconnectSource === 'tab') {
          sendSafe('FW_POP', { type: 'REQUEST_STREAM', tabId: reconnectTabId, source: 'tab' });
        } else if (reconnectSource === 'system') {
          if (!preStream || epoch !== sessionEpoch) {
            preStream?.getTracks().forEach((t) => t.stop());
            return;
          }
          try {
            await pipeCaptureStream(preStream, 'system');
          } catch (e: any) {
            // 管道搭建失败（AudioWorklet 双路皆挂）：音频进不来，必须终结会话而非空挂 Running
            log('系统音频接入管道失败: ' + (e?.message || e));
            preStream.getTracks().forEach((t) => t.stop());
            sendSafe('FW_POP', { type: 'ERROR', message: `系统音频接入失败: ${e?.message || e}` });
            sendSafe('FW_STOP', {});
            return;
          }
        }
        // mic：什么都不做——悬浮窗采集的 PCM 会以 MIC_CHUNK 消息持续流入（见下方处理器）
        } catch (e: any) { log('INIT_OFFSCREEN async 异常: ' + await describeWasmException(e)); throw e; }
      })().catch(async (e) => {
        log('Pipeline start 异常: ' + await describeWasmException(e));
        sendSafe('FW_POP', { type: 'ERROR', message: `Pipeline启动失败: ${e.message || e}` });
      });
    }

    if (msg.type === 'SET_PUNCT') {
      usePunct = msg.enabled !== false;
      log('标点功能: ' + (usePunct ? '开' : '关'));
    }

    if (msg.type === 'RESEND_CURRENT_TEXT') {
      if (lastText || prevSentence) {
        const display = displayCase(lastText);
        sendSafe('FW_CT', { type: 'OVERLAY_TEXT', prev: prevSentence, current: display });
        sendSafe('FW_CT', { type: 'TEXT_CHANGED', text: display });
        sendSafe('FW_POP', { type: 'TEXT_CHANGED', text: display });
      }
    }

    if (msg.type === 'SET_ENDPOINT') {
      log(`端点阈值 saved: ${msg.rule1}/${msg.rule2}/${msg.rule3} (重启生效)`);
    }

    if (msg.type === 'TRANSLATE_TEST') {
      testTranslate(String(msg.text ?? ''), msg.direction || 'auto').then(r => {
        sendSafe('TRANSLATE_TEST_RESULT', { id: msg.id, ...r });
      });
    }

    if (msg.type === 'TRANSLATE_TEST_CANCEL') {
      // 面板二次点击"取消"：终止测试 worker（若为测试临时创建的）并结束挂起的应答。
      // 此前 bg 侧没有这条消息的分支、这里也没有处理——"取消"按钮是假的，
      // 临时 worker 会继续把 216MB 翻译模型加载完（白烧数秒 CPU）才因结果返回而收尾。
      cancelTranslateTest();
    }

    if (msg.type === 'MIC_CHUNK') {
      // mic 模式音频入口：悬浮窗（可见扩展页）采集 PCM，经 bg 逐块转发至此。
      // 坑：Port 走 JSON 克隆，ArrayBuffer 到这里已变成普通数组（见 floating.ts 注释），
      // 故这里按 number[] 还原；同时兼容直传 ArrayBuffer 的情形。
      // pipeline 为空（已停止/重启间隙）直接丢弃，不报错。
      if (!msg.audio || !pipeline) return;
      const buf = Array.isArray(msg.audio)
        ? Float32Array.from(msg.audio as number[])
        : new Float32Array(msg.audio);
      if (!buf.length) return;
      recordLevel(buf);
      const sr = msg.sampleRate || 16000;
      pipeline.feedAudio(sr === 16000 ? buf : resample(buf, sr, 16000));
      return;
    }

    if (msg.type === 'STREAM_READY') {
      // background 对 REQUEST_STREAM 的应答：拿到新鲜 streamId，立即开流。
      // 仅 tab 模式会收到（system 模式走 acquireSystemAudioStream，无此消息）。
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
      sessionEpoch++;
      reconnectTabId = null;
      reconnectStreamId = null;
      stopAudio();
      destroyTranslateWorker();
      translateEnabled = false;
      pipeline?.stop();
      pipeline = null;
      // 坑：停止同样要作废在途的标点延迟回调，否则迟到的标点结果会把已清空的
      // 字幕重新写回缓存并推给 content/popup，表现为"点了停止字幕又复活"。
      punctPending = false;
      punctEpoch++;
      // 坑：STOP 到达与 background 销毁本文档之间存在窗口（closeDocument 异步生效），
      // 期间 RESEND_CURRENT_TEXT / 迟到的标点回调仍可能把上一场的旧句推上屏；
      // 显式清零会话文本状态，保证任何时点看到的都是"已停止"该有的空白。
      lastText = '';
      prevSentence = '';
      lastPunctText = '';
      // 停止即归零电平包络并停发（pipeline 已置 null，recordLevel 的 Running 守卫兜底）。
      levelEnv = 0;
      lastLevelSentAt = 0;
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
  // 先等脚本注入完成（含 IndexedDB → blob URL），再轮询 __wasmReady
  await asrDataReady;
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
