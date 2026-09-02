// ponytail: onRuntimeInitialized 只设 __wasmReady，不在 preload 中创建 recognizer
// 双 recognizer 同时存在导致 WASM 堆崩溃（模型二次加载）
// waitForWasm() 在 offscreen.ts 中轮询此标志，无超时保护（WASM 加载失败则无限循环）
var Module = {
  locateFile: function(path) {
    // nomodel 版：offscreen.ts 在动态注入本脚本前已把 IndexedDB 里的模型读成 blob URL，
    // 这里同步返回即可被加载器的 fetch 无缝接管；包内自带 .data 时 __asrDataUrl 为空走原路径
    if (path.endsWith('.data') && window.__asrDataUrl) return window.__asrDataUrl;
    return chrome.runtime.getURL('wasm/' + path);
  },
  onRuntimeInitialized: function() {
    window.__wasmReady = true;
  }
};
