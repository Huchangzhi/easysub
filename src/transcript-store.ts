// 字幕记录持久化（跨宿主共用）：扩展 background 与 Web 版宿主都走这一份，
// 保证两端的存储契约、裁剪策略、译文挂载语义完全一致。
//
// 契约：{ text: string, ts: number, tr?: string }
//   ts = Date.now()（句完成时刻）；ts=0 是"legacy 无时标"哨兵值，
//   显示/导出侧据此决定是否渲染时间戳。
//   tr = 该句定稿译文，由 TRANSLATION_FINAL 在换句后按 seq 挂到对应原句上。
import { storage, IS_EXTENSION } from './platform';

export const TRANSCRIPT_KEY = 'tmspeech_transcript';
// 上限随宿主定：扩展走 chrome.storage.local（配额 10MB，1000 条中文长句约 1~2MB，安全）；
// 纯 Web 版走 localStorage（配额通常 5MB，且与同域其它数据共享），压到 500 条留足余量——
// 超配额时 set 会整体失败、转写从此停止记录，比"少留几条历史"严重得多。
export const TRANSCRIPT_MAX = IS_EXTENSION ? 1000 : 500;

export interface TranscriptEntry { text: string; ts: number; tr?: string }

// 坑：storage 的 get→push→set 是三步非原子操作，两条 SENTENCE_DONE 交错执行时
// 后写会整体覆盖前写、丢掉一句转写。改为 promise 链串行化：同一时刻只允许一个读改写
// 在途，后续追加排队等待（链条内所有异常都被捕获，队列永不 reject、不会卡死）。
let queue: Promise<void> = Promise.resolve();

// 坑：legacy 格式原因——旧版本把转写存成纯字符串数组且无迁移脚本，升级后存储里
// 会长期残留字符串条目。所有读取点必须做 typeof entry === 'string' 的懒归一化
// （归一化结果随后随整组写回，老数据在首次追加后即被逐步原地迁移），否则显示侧
// 读到 .text/.ts 属性就是 undefined，直接炸 UI。
export function normalizeTranscriptEntry(entry: unknown): TranscriptEntry {
  if (typeof entry === 'string') return { text: entry, ts: 0 };
  const e = entry as Partial<TranscriptEntry>;
  return {
    text: typeof e.text === 'string' ? e.text : '',
    ts: typeof e.ts === 'number' ? e.ts : 0,
    tr: typeof e.tr === 'string' && e.tr ? e.tr : undefined,
  };
}

export async function readTranscript(): Promise<TranscriptEntry[]> {
  const r = await storage.get(TRANSCRIPT_KEY);
  return ((r[TRANSCRIPT_KEY] as unknown[]) || []).map(normalizeTranscriptEntry);
}

// 坑：数组原本只增不减，每句都把整个数组重新序列化写入（累计 O(n²)），且 storage.local
// 配额 10MB，长会话触顶后 set 永久静默失败、转写从此停止记录。写入前裁剪到上限。
export function appendTranscript(text: string, ts: number = Date.now(), onError?: (e: unknown) => void) {
  queue = queue.then(async () => {
    try {
      const arr = await readTranscript();
      // 坑：必须用入参 ts——队列内再取 Date.now() 会在积压时漂移，入库时刻与
      // 转发给面板的盖章时刻分叉，重开面板后时标对不上实时所见
      arr.push({ text, ts });
      if (arr.length > TRANSCRIPT_MAX) arr.splice(0, arr.length - TRANSCRIPT_MAX);
      await storage.set({ [TRANSCRIPT_KEY]: arr });
    } catch (e) {
      // 配额触顶/存储异常不再静默：至少留一条日志可查。
      (onError || ((err) => console.log('[EasySub] 转写持久化失败:', err)))(e);
    }
  });
}

// 换句后的定稿译文挂到历史原句上。旧实现无条件挂"末条"：一旦识别端积压
// （慢速机器/长句推理），TRANSLATION_FINAL 迟到时面板里可能已插入了更新的句子，
// 译文就会被挂错句——这正是"记录里部分句子翻译丢失/错位"的成因。
// 现在条目带 seq（随 SENTENCE_DONE 原样送达），译文按 seq 精确配对；
// seq 缺失（旧消息/异常路径）才退回"末条无译文"的旧语义。
// 走同一串行队列，避免与 appendTranscript 的读改写并发互相覆盖丢数据。
export function attachTranscriptTranslation(text: string, seq?: number, onError?: (e: unknown) => void) {
  if (!text) return;
  queue = queue.then(async () => {
    try {
      const arr = await readTranscript();
      let target: TranscriptEntry | undefined;
      if (typeof seq === 'number' && seq > 0) {
        // seq 从 1 起、条目按句追加：本会话第 seq 条即"从尾部数第 seq 条"
        //（storage 跨会话累积，但条目只增不删（裁剪只去最老），尾部对齐恒成立）。
        const backIdx = arr.length - seq;
        if (backIdx >= 0 && backIdx < arr.length) target = arr[backIdx];
        // 坑：目标条目已有译文时不许挪位到"末条"——末条可能是更新的句子，
        // 挪位即错挂（重复交付已在识别端队列层拦截，这里是最后防线）。
      } else {
        target = arr[arr.length - 1]; // 无 seq 的旧消息：退回"末条"旧语义
      }
      if (target && !target.tr) target.tr = String(text);
      await storage.set({ [TRANSCRIPT_KEY]: arr });
    } catch (e) {
      (onError || ((err) => console.log('[EasySub] 转写译文持久化失败:', err)))(e);
    }
  });
}

export function clearTranscript(): Promise<void> {
  queue = queue.then(() => storage.remove(TRANSCRIPT_KEY)).then(() => undefined, () => undefined);
  return queue;
}

export function writeTranscript(entries: TranscriptEntry[]): Promise<void> {
  queue = queue.then(() => storage.set({ [TRANSCRIPT_KEY]: entries })).then(() => undefined, () => undefined);
  return queue;
}
