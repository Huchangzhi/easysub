// ponytail: onRuntimeInitialized 只设 __wasmReady，不在 preload 中创建 recognizer
// 双 recognizer 同时存在导致 WASM 堆崩溃（模型二次加载）
// 宿主侧（asr-engine.ts 的 waitForWasm）轮询此标志，有 30s 超时兜底。
//
// 宿主无关：wasm 目录的绝对 URL 由宿主在加载本脚本前挂到 window.__easysubWasmBase
// （扩展 = chrome.runtime.getURL('wasm/')，Web = './wasm/'）。这样同一个 preload.js
// 既能跑在扩展 offscreen 文档里，也能直接扔到 GitHub Pages 上。
var Module = {
  locateFile: function(path) {
    // nomodel 版：宿主在动态注入本脚本前已把 IndexedDB 里的模型读成 blob URL，
    // 这里同步返回即可被加载器的 fetch 无缝接管；包内自带 .data 时 __asrDataUrl
    // 为空走宿主给的基址
    if (path.endsWith('.data') && window.__asrDataUrl) return window.__asrDataUrl;
    var base = window.__easysubWasmBase;
    if (!base) {
      // 兜底：宿主忘了挂基址时按本脚本自身位置推导（扩展里这条走不到，
      // 因为扩展必须经 chrome.runtime.getURL 才能绕过页面 CSP）
      base = (typeof document !== 'undefined' && document.currentScript)
        ? document.currentScript.src.replace(/[^/]*$/, '')
        : 'wasm/';
    }
    return base + path;
  },
  onRuntimeInitialized: function() {
    window.__wasmReady = true;
  }
};
