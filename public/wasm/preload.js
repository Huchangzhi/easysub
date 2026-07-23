var Module = {
  locateFile: function(path) {
    return chrome.runtime.getURL('wasm/' + path);
  },
  onRuntimeInitialized: function() {
    window.__wasmReady = true;
    window.__recognizer = createOnlineRecognizer(Module, {
      rule1MinTrailingSilence: 1.2,
      rule2MinTrailingSilence: 0.8,
      rule3MinUtteranceLength: 10,
    });
  }
};
