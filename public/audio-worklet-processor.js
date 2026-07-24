// ponytail: 纯 JS 文件不走 Webpack（Webpack IIFE wrap 导致 AudioWorkletGlobalScope 里 self 不可用）
class AudioBufferProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.port.onmessage = (e) => {
      if (e.data === 'flush') {
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
    };
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length > 0) {
      this.buffer.push(new Float32Array(input[0]));
    }
    // ponytail: 返回 false 会导致 processor 被 GC，buffer 累积永远不释放
    return true;
  }
}
registerProcessor('audio-buffer', AudioBufferProcessor);
