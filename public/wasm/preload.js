// pitfall: createOnlineRecognizer 内部用 Object.assign 合并 myConfig，不是替换
// 不能传完整 config 否则 model 路径会丢失；只传要覆盖的字段即可
var Module = {
  locateFile: function(path) {
    return chrome.runtime.getURL('wasm/' + path);
  },
  onRuntimeInitialized: function() {
    window.__wasmReady = true;
    window.__recognizer = createOnlineRecognizer(Module, {
      rule1MinTrailingSilence: 0.6,
      rule2MinTrailingSilence: 0.4,
      rule3MinUtteranceLength: 12,
    });
  }
};
