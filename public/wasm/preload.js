var Module = {
  locateFile: function(path) {
    return chrome.runtime.getURL('wasm/' + path);
  },
  onRuntimeInitialized: function() {
    window.__wasmReady = true;
    window.__recognizer = createOnlineRecognizer(Module);
  }
};
