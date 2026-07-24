// ponytail: onRuntimeInitialized 只设 __wasmReady，不在 preload 中创建 recognizer
// 双 recognizer 同时存在导致 WASM 堆崩溃（模型二次加载）
// waitForWasm() 在 offscreen.ts 中轮询此标志，无超时保护（WASM 加载失败则无限循环）
var Module = {
  locateFile: function(path) {
    return chrome.runtime.getURL('wasm/' + path);
  },
  onRuntimeInitialized: function() {
    window.__wasmReady = true;
  }
};
