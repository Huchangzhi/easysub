# TM Speech 浏览器扩展

原项目 [TMSpeech](https://github.com/anomalyco/TMSpeech)（.NET 桌面应用）的浏览器扩展移植版。

## 架构

```
麦克风/标签页音频 → Web Audio API → ONNX Runtime Web (WebGPU) → 字幕叠加层
```

- **WebGPU** 加速 ONNX 模型推理
- **Whisper** 模型离线语音识别
- **Chrome Extension** Manifest V3

## 对应关系

| 原项目 | 扩展版 |
|--------|--------|
| `TMSpeech.Core/JobManager.cs` | `src/pipeline.ts` |
| `TMSpeech.Recognizer.SherpaOnnx` | `src/recognizer.ts` |
| `TMSpeech.AudioSource.Windows` | `src/audio-processor.ts` |
| `TMSpeech.GUI/Views/MainWindow` | `src/content.ts` (叠加层) |
| `TMSpeech.GUI/Views/ConfigWindow` | `src/popup.ts` |

## 开发

```bash
npm install
npm run build
```

然后 Chrome → 扩展程序 → 加载已解压的扩展 → 选择 `dist/` 目录。

## 模型

扩展启动时自动从 HuggingFace 下载 Whisper ONNX 模型。
- whisper-tiny: ~150MB
- whisper-base: ~290MB
