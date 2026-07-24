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
    this.stream = r.createStream();
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
