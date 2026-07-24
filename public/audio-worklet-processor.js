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
        this.port.postMessage({ audio: out.buffer, sampleRate: sampleRate }, [out.buffer]);
      }
    };
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length > 0) {
      this.buffer.push(new Float32Array(input[0]));
    }
    return true;
  }
}
registerProcessor('audio-buffer', AudioBufferProcessor);
