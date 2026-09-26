// ponytail: 纯 JS 文件不走 Webpack（Webpack IIFE wrap 导致 AudioWorkletGlobalScope 里 self 不可用）
//
// 双模式出块（两条路并存，互不干扰）：
//   ① pull —— 主线程发 'flush' 指令，本 processor 把积累的音频一次性回吐。
//      扩展 offscreen 文档走这条（文档不受后台节流影响，60ms 定时器链稳定）。
//   ② push —— 累计帧数达到约 60ms 就自己回吐一次。
//      纯 Web 版走这条：面板页被字幕浮窗盖住后是后台标签页，setTimeout 会被 Chrome
//      节流到分钟级，pull 模式下音频只进不出、识别直接停摆（且不报错，最难排查）。
//      AudioWorklet 跑在音频线程、不受页面节流影响，所以由它自己掌握节奏。
// 空块（pull 与 push 撞在一起时缓冲区已清空）由接收端按长度 0 丢弃，无副作用。
class AudioBufferProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.acc = 0;
    // 目标块长：约 60ms。缓冲一旦攒够就主动回吐（push 模式）。
    this.interval = Math.max(1024, Math.round(sampleRate * 0.06));
    this.port.onmessage = (e) => {
      if (e.data === 'flush') this.flush();
    };
  }

  flush() {
    if (this.buffer.length === 0) return;
    const len = this.buffer.reduce((a, b) => a + b.length, 0);
    const out = new Float32Array(len);
    let offset = 0;
    for (const b of this.buffer) {
      out.set(b, offset);
      offset += b.length;
    }
    this.buffer = [];
    // ponytail: out.buffer 在 transfer 后被 detached，不可再读
    this.port.postMessage({ audio: out.buffer, sampleRate: sampleRate }, [out.buffer]);
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length > 0) {
      this.buffer.push(new Float32Array(input[0]));
      this.acc += input[0].length;
      if (this.acc >= this.interval) {
        this.acc = 0;
        this.flush();
      }
    }
    // ponytail: 返回 false 会导致 processor 被 GC，buffer 累积永远不释放
    return true;
  }
}
registerProcessor('audio-buffer', AudioBufferProcessor);
