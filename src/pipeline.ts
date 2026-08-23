export enum JobStatus { Stopped, Running }

export interface PipelineEvents {
  onTextChanged: (text: string) => void;
  onSentenceDone: (text: string) => void;
  onStatusChanged: (status: JobStatus) => void;
  onError: (err: Error) => void;
}

let log = (msg: string) => console.log('[TM Pipeline]', msg);

function cleanText(text: string): string {
  return text.replace(/▁/g, ' ').trim();
}

export class Pipeline {
  private status = JobStatus.Stopped;
  private events: PipelineEvents;
  private cancelled = false;
  private stream: any = null;
  private lastText = '';

  constructor(events: PipelineEvents) {
    this.events = events;
  }

  getStatus() { return this.status; }

  async start() {
    if (this.status === JobStatus.Running) return;

    const r = (window as any).__recognizer;
    if (!r || !(window as any).__wasmReady) {
      this.events.onError(new Error('WASM 识别器未就绪'));
      return;
    }

    this.status = JobStatus.Running;
    this.cancelled = false;
    // 坑：createStream 在 WASM 内存紧张/句柄创建失败时可能抛异常或返回无效句柄。
    // 若不加保护：status 已置 Running 但 stream 为 null——start() 因开头幂等短路
    // 永远无法重启，feedAudio 因守卫静默丢弃全部音频，形成无法自恢复的"假 Running"。
    // 修复：失败时回滚 status=Stopped 并向上抛出，由 offscreen 的 async INIT 链路
    // catch 后走 ERROR 通道上报（offscreen.ts 对 pipeline!.start() 已有 try/catch 包裹）；
    // 同时校验返回的流及其内部句柄真值，防止后续 wasm 调用在句柄 0 上直接 abort。
    try {
      this.stream = r.createStream();
    } catch (e) {
      this.status = JobStatus.Stopped;
      this.stream = null;
      throw e instanceof Error ? e : new Error('识别流创建失败: ' + String(e));
    }
    if (!this.stream || !this.stream.handle) {
      this.status = JobStatus.Stopped;
      this.stream = null;
      throw new Error('识别流创建失败：返回无效句柄');
    }
    this.events.onStatusChanged(JobStatus.Running);
    log('识别流已创建');
  }

  stop() {
    this.cancelled = true;
    this.status = JobStatus.Stopped;
    this.stream?.free();
    this.stream = null;
    this.lastText = '';
    this.events.onStatusChanged(JobStatus.Stopped);
    this.events.onTextChanged('');
  }

  feedAudio(samples: Float32Array) {
    if (this.status !== JobStatus.Running || !this.stream) return;

    const r = (window as any).__recognizer;
    if (!r) return;

    this.stream.acceptWaveform(16000, samples);
    // ponytail: isReady 可能永不返回 false（极低概率），无迭代限制，阻塞主线程
    while (r.isReady(this.stream)) {
      r.decode(this.stream);
    }

    const isEndpoint = r.isEndpoint(this.stream);
    const result = r.getResult(this.stream).text;
    const clean = cleanText(result);

    if (clean && clean !== this.lastText) {
      this.lastText = clean;
      this.events.onTextChanged(clean);
    }

    if (isEndpoint && clean) {
      log('句完成: "' + clean + '"');
      this.events.onSentenceDone(clean);
      r.reset(this.stream);
      this.lastText = '';
    }
  }
}
