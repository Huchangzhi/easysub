// ponytail: 纯 JS 文件不走 Webpack（Webpack IIFE wrap 导致 AudioWorkletGlobalScope 里 self 不可用）
//
// 出块模式两选一，由宿主在构造 AudioWorkletNode 时用 processorOptions 指定：
//   ① pull（默认，pushMs 缺省/0）—— 主线程发 'flush' 指令，本 processor 把积累的音频回吐。
//      扩展 offscreen 文档的识别采集走这条：它不受页面节流影响，且"发送 flush → 收到回包"
//      的因果关系成立（延迟指示据此测往返时间）。
//   ② push（pushMs > 0）—— 累计帧数达到该时长就自己回吐。
//      纯 Web 面板页与扩展悬浮窗的麦克风采集走这条：它们可能被最小化/被盖住而进入后台，
//      setTimeout 会被 Chrome 节流到分钟级，pull 模式下音频只进不出、识别直接停摆
//      （且不报错，最难排查）。AudioWorklet 跑在音频线程、不受页面节流影响，所以由它自己
//      掌握节奏。麦克风链路不参与延迟测量（只记电平），push 不会让指标失真。
// 坑：push 必须**显式开启**。早期版本无条件开启 push，扩展侧虽然仍能出字，但延迟指示
// 测的"flush 往返时间"失去因果（回包由 push 触发，flush 发出时刻是陈旧值），数值失真。
// 空块（pull 与 push 撞在一起时缓冲区已清空）由接收端按长度 0 丢弃，无副作用。
class AudioBufferProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.buffer = [];
    this.acc = 0;
    const pushMs = Number(options && options.processorOptions && options.processorOptions.pushMs) || 0;
    // 目标块长：约 60ms。0 表示只走 pull，永远不主动回吐。
    this.interval = pushMs > 0 ? Math.max(1024, Math.round(sampleRate * pushMs / 1000)) : 0;
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
      if (this.interval > 0) {
        this.acc += input[0].length;
        if (this.acc >= this.interval) {
          this.acc = 0;
          this.flush();
        }
      }
    }
    // ponytail: 返回 false 会导致 processor 被 GC，buffer 累积永远不释放
    return true;
  }
}
registerProcessor('audio-buffer', AudioBufferProcessor);
