// ⚠️ 补丁版本 — 不要用 release 的原始版替换
// 原始版缺少 typeof process 守卫，浏览器中 module 未定义直接炸
// 若更新 WASM，请重新添加 if(typeof process=='object'...) 包裹 module.exports
function freeConfig(config, Module) {
  if ('buffer' in config) {
    Module._free(config.buffer);
  }

  if ('config' in config) {
    freeConfig(config.config, Module)
  }

  Module._free(config.ptr);
}

function initSherpaOnnxOfflinePunctuationModelConfig(config, Module) {
  const model = config.ctTransformer || '';
  const modelLen = Module.lengthBytesUTF8(model) + 1;
  const provider = config.provider || 'cpu';
  const providerLen = Module.lengthBytesUTF8(provider) + 1;

  const n = modelLen + providerLen;
  const buffer = Module._malloc(n);

  const len = 4 * 4;
  const ptr = Module._malloc(len);

  let offset = 0;
  Module.stringToUTF8(model, buffer + offset, modelLen);
  offset += modelLen;

  Module.stringToUTF8(provider, buffer + offset, providerLen);

  offset = 0;
  Module.setValue(ptr + offset, buffer + offset, 'i8*');
  offset += 4;
  Module.setValue(ptr + offset, config.numThreads || 1, 'i32');
  offset += 4;
  Module.setValue(ptr + offset, config.debug || 0, 'i32');
  offset += 4;
  Module.setValue(ptr + offset, buffer + modelLen, 'i8*');

  return {
    buffer: buffer,
    ptr: ptr,
    len: len,
  };
}

function initSherpaOnnxOfflinePunctuationConfig(config, Module) {
  if (!('model' in config)) {
    config.model = {};
  }

  const modelConfig =
      initSherpaOnnxOfflinePunctuationModelConfig(config.model, Module);
  const len = modelConfig.len;
  const ptr = Module._malloc(len);

  Module._CopyHeap(modelConfig.ptr, modelConfig.len, ptr);

  return {
    ptr: ptr,
    len: len,
    config: modelConfig,
  };
}

function initSherpaOnnxOnlinePunctuationModelConfig(config, Module) {
  const model = config.cnnBilstm || '';
  const modelLen = Module.lengthBytesUTF8(model) + 1;
  const bpeVocab = config.bpeVocab || '';
  const bpeVocabLen = Module.lengthBytesUTF8(bpeVocab) + 1;
  const provider = config.provider || 'cpu';
  const providerLen = Module.lengthBytesUTF8(provider) + 1;

  const n = modelLen + bpeVocabLen + providerLen;
  const buffer = Module._malloc(n);

  const len = 5 * 4;
  const ptr = Module._malloc(len);

  let offset = 0;
  Module.stringToUTF8(model, buffer + offset, modelLen);
  offset += modelLen;

  Module.stringToUTF8(bpeVocab, buffer + offset, bpeVocabLen);
  offset += bpeVocabLen;

  Module.stringToUTF8(provider, buffer + offset, providerLen);

  offset = 0;
  Module.setValue(ptr + offset, buffer + offset, 'i8*');
  offset += 4;
  Module.setValue(ptr + offset, buffer + modelLen, 'i8*');
  offset += 4;
  Module.setValue(ptr + offset, config.numThreads || 1, 'i32');
  offset += 4;
  Module.setValue(ptr + offset, config.debug || 0, 'i32');
  offset += 4;
  Module.setValue(ptr + offset, buffer + modelLen + bpeVocabLen, 'i8*');

  return {
    buffer: buffer,
    ptr: ptr,
    len: len,
  };
}

function initSherpaOnnxOnlinePunctuationConfig(config, Module) {
  if (!('model' in config)) {
    config.model = {};
  }

  const modelConfig =
      initSherpaOnnxOnlinePunctuationModelConfig(config.model, Module);
  const len = modelConfig.len;
  const ptr = Module._malloc(len);

  Module._CopyHeap(modelConfig.ptr, modelConfig.len, ptr);

  return {
    ptr: ptr,
    len: len,
    config: modelConfig,
  };
}

function copyTextAndFree(ptr, freeFn, Module) {
  if (!ptr) {
    return '';
  }

  const text = Module.UTF8ToString(ptr);
  freeFn.call(Module, ptr);
  return text;
}

class OfflinePunctuation {
  constructor(configObj, Module) {
    const config = initSherpaOnnxOfflinePunctuationConfig(configObj, Module);
    const handle = Module._SherpaOnnxCreateOfflinePunctuation(config.ptr);

    freeConfig(config, Module);

    this.handle = handle;
    this.Module = Module;
  }

  free() {
    this.Module._SherpaOnnxDestroyOfflinePunctuation(this.handle);
    this.handle = 0;
  }

  addPunct(text) {
    const textLen = this.Module.lengthBytesUTF8(text) + 1;
    const textPtr = this.Module._malloc(textLen);
    this.Module.stringToUTF8(text, textPtr, textLen);

    const out = this.Module._SherpaOfflinePunctuationAddPunct(
        this.handle, textPtr);
    this.Module._free(textPtr);

    return copyTextAndFree(
        out, this.Module._SherpaOfflinePunctuationFreeText, this.Module);
  }
}

class OnlinePunctuation {
  constructor(configObj, Module) {
    const config = initSherpaOnnxOnlinePunctuationConfig(configObj, Module);
    const handle = Module._SherpaOnnxCreateOnlinePunctuation(config.ptr);

    freeConfig(config, Module);

    this.handle = handle;
    this.Module = Module;
  }

  free() {
    this.Module._SherpaOnnxDestroyOnlinePunctuation(this.handle);
    this.handle = 0;
  }

  addPunct(text) {
    const textLen = this.Module.lengthBytesUTF8(text) + 1;
    const textPtr = this.Module._malloc(textLen);
    this.Module.stringToUTF8(text, textPtr, textLen);

    const out = this.Module._SherpaOnnxOnlinePunctuationAddPunct(
        this.handle, textPtr);
    this.Module._free(textPtr);

    return copyTextAndFree(
        out, this.Module._SherpaOnnxOnlinePunctuationFreeText, this.Module);
  }
}

// pitfall: class 声明不挂 window（只有 var 才会），webpack 模块里 window.X 拿不到
// 必须显式赋值给 window
if (typeof window != 'undefined') {
  window.OfflinePunctuation = OfflinePunctuation;
  window.OnlinePunctuation = OnlinePunctuation;
}

if (typeof process == 'object' && typeof process.versions == 'object' &&
    typeof process.versions.node == 'string') {
  module.exports = {
    OfflinePunctuation,
    OnlinePunctuation,
  };
}
