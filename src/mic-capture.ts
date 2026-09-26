// 麦克风采集（跨宿主共用）：16k 单声道定长出块，交调用方决定怎么送给识别引擎。
//
// 为什么不是识别引擎自己采：
//   - 扩展侧 Chrome 禁止 offscreen 文档做 getUserMedia 音频采集（NotAllowedError），
//     必须由可见页（悬浮字幕窗）采集后经 bg 转发；
//   - Web 侧页面本身就是可见窗口，可直接采。
// 两者"谁来调 getUserMedia"不同，但"怎么采、怎么出块"完全一样，故只抽这一层。
import { resolveUrl } from './platform';

export interface MicCaptureOptions {
  // 每约 60ms 回调一块 16k 单声道 PCM
  onChunk: (samples: Float32Array, sampleRate: number) => void;
  // 采集失败/设备中途断开。name 是 DOMException.name（NotAllowedError / TrackEnded 等）
  onError: (name: string, message: string) => void;
}

export class MicCapture {
  private opts: MicCaptureOptions;
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private timer: any = null;
  private active = false;

  constructor(opts: MicCaptureOptions) {
    this.opts = opts;
  }

  get isActive() { return this.active; }

  stop() {
    this.active = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.node) { try { this.node.port.onmessage = null; this.node.disconnect(); } catch { /* 已断开 */ } this.node = null; }
    if (this.ctx) { this.ctx.close().catch(() => {}); this.ctx = null; }
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
  }

  async start(): Promise<void> {
    // 重复指令（启动直发 + 端口重连补发双入口）幂等跳过：已在采就不重开
    if (this.active) return;
    this.stop();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e: any) {
      this.opts.onError(e?.name || '', e?.message || String(e));
      return;
    }
    try {
      // 强制 16k：下游识别管道直吃，零重采样
      this.ctx = new AudioContext({ sampleRate: 16000 });
      const src = this.ctx.createMediaStreamSource(this.stream);
      await this.ctx.audioWorklet.addModule(resolveUrl('audio-worklet-processor.js'));
      const node = new AudioWorkletNode(this.ctx, 'audio-buffer');
      this.node = node;
      src.connect(node);
      node.port.onmessage = (ev: MessageEvent) => {
        if (!ev.data?.audio) return;
        const f32 = new Float32Array(ev.data.audio);
        if (!f32.length) return;
        this.opts.onChunk(f32, ev.data.sampleRate || 16000);
      };
      // 与识别引擎本地采集同一节拍：60ms 推一次 flush，让 worklet 吐块。
      // （worklet 自身也会按 60ms 主动 push，两条路并存、空块被接收端丢弃）
      this.timer = setInterval(() => { try { node.port.postMessage('flush'); } catch { /* 节点已销毁 */ } }, 60);
      this.active = true;
      // 设备中途被拔：轨道 ended 即断粮，必须上报结束会话（无音频的 Running 是幽灵态）
      this.stream.getAudioTracks()[0]?.addEventListener('ended', () => {
        if (!this.active) return;
        this.stop();
        this.opts.onError('TrackEnded', '麦克风设备已断开');
      });
    } catch (e: any) {
      this.stop();
      this.opts.onError(e?.name || '', e?.message || String(e));
    }
  }
}
