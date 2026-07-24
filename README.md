# 易字幕 / EasySub

<p>
  <img src="logo.jpg" width="64" height="64" style="border-radius:12px;">
</p>

免费、安全的基于本地模型的实时字幕浏览器扩展。

## 简介

易字幕 是一款完全离线的浏览器扩展，无需注册、无需联网、无需上传任何数据。通过 WASM 在本地运行语音识别模型，在浏览任意网页时实时生成字幕。

- **免费** — 无付费，无订阅
- **安全** — 所有计算在本地完成，音频数据不上传
- **离线** — 模型加载后可离线使用
- **实时** — 低延迟流式识别，说话即现

## 使用

1. 安装扩展后，点击浏览器工具栏的图标打开面板
2. 点击 **开始** 按钮
3. 当前标签页播放的音频会自动生成字幕叠加层
4. 可拖动调整字幕位置，锁定、调节字号

## 开发

```bash
npm install
# 首次构建需要下载模型 (full 版, 357MB)
npm run download-wasm
# 如需轻量版 (lite, 150MB) 使用:
# npm run download-wasm -- --lite
npm run build
```

> ⚠️ `public/wasm/sherpa-onnx-asr.js` 和 `public/wasm/sherpa-onnx-punctuation.js`
> 是**补丁版本**，修复了 WASM builder release 中 config 被替换、module 守卫缺失的 bug。
> 若更新 WASM，务必重新应用或保留 git 跟踪的版本，不要直接替换。

然后 Chrome → 扩展程序 → 加载已解压的扩展 → 选择 `dist/` 目录。

## 技术栈

- **识别引擎**: [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx/) WASM 离线推理
- **模型**: Zipformer 中英双语 — [full] 全量版 (fp32, 357MB) / [lite] 轻量版 (int8, 150MB)
- **标点恢复**: CT-Transformer INT8 + 规则回退（流式非阻塞，句完成调模型）
- **架构**: Chrome Extension Manifest V3

## 架构

```
┌──────────────┐   popup.html     ┌─────────────────────────────┐
│  Popup UI    │ ◄── popup.ts ──  │  Background Service Worker  │
│ (控制面板)    │                  │  (background.ts)            │
└──────────────┘                  │  状态管理 / 消息路由         │
       ▲                         │  offscreen 生命周期          │
       │ chrome.runtime          └───────────┬─────────────────┘
       ▼                                     │ chrome.runtime.connect
┌──────────────────────┐                     │
│  Content Script      │                     ▼
│  (content.ts)        │        ┌──────────────────────────────┐
│  网页字幕叠加层       │ ◄──── │  Offscreen Document          │
│  拖动 / 锁定 / 动画   │        │  (offscreen.html + .ts)      │
└──────────────────────┘        │                              │
                                │  ┌──────────────────────┐    │
                                │  │  sherpa-onnx WASM    │    │
                                │  │  ASR 模型 (Zipformer)│    │
                                │  │  自动断句 + 端点检测  │    │
                                │  └──────────────────────┘    │
                                │  ┌──────────────────────┐    │
                                │  │  CT-Transformer      │    │
                                │  │  标点恢复 (INT8)     │    │
                                │  │  setTimeout(0) 异步  │    │
                                │  └──────────────────────┘    │
                                │                              │
                                │  ┌──────────────────────┐    │
                                │  │  AudioWorklet        │    │
                                │  │  (音频线程)            │    │
                                │  │  独立读帧 / 缓冲      │    │
                                │  │  主线程阻塞不丢帧     │    │
                                │  └──────────────────────┘    │
                                └──────────────────────────────┘
```

### 数据流

1. **音频捕获**: AudioWorklet（`audio-worklet-processor.js`）在独立音频线程读取 tab 音频
2. **缓冲**: 主线程定时（60ms）从 AudioWorklet 拉取累积音频帧
3. **ASR 解码**: `pipeline.feedAudio()` → sherpa-onnx `acceptWaveform()` + `decode()`
4. **流式文本**: `onTextChanged` → 立即送显示 → `setTimeout(0)` 触发标点恢复
5. **标点恢复**: CT-Transformer 模型推理（同步阻塞主线程），AudioWorklet 继续缓冲不丢帧
6. **句完成**: `onSentenceDone` → 终版标点 → 追加到字幕记录 → 清理缓存
7. **显示**: content script 收到文本 → 更新叠加层（流式标点/终版标点）

### 进程模型

```
Tab Audio ──→ AudioWorklet (音频线程)
                  │ 持续缓冲
                  │ 60ms 定时 flush
                  ▼
Offscreen 主线程 ──→ ASR 解码 ──→ 文本
                  │                │
                  │      setTimeout(0) 非阻塞
                  │                │
                  ▼                ▼
             AudioWorklet      CT-Transformer
             继续缓冲音频        标点推理（短期阻塞）
                  │                │
                  └── 解阻塞 ────┘
                          │
                          ▼
                     pipeline.feedAudio(积压帧)
```

### 降级路径

- **AudioWorklet 不可用**（极旧 Chrome）→ `ScriptProcessorNode` 缓冲 16384 帧
- **标点模型加载失败** → 纯规则标点（正则 + 上下文判断）
- **MediaStreamTrack 不可转移** → 已确认不可行，AudioWorklet 是正式方案

## 鸣谢

- [Loser123zbx](https://github.com/Loser123zbx) — Logo 设计
- [jxlpzqc/TMSpeech](https://github.com/jxlpzqc/TMSpeech) — 项目灵感来源
- [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx/) — 离线语音识别引擎
- [Zipformer](https://github.com/k2-fsa/sherpa-onnx/) — 中英双语识别模型

## 许可证

MIT License © 2026 hcz1017
