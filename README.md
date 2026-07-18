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
# 首次构建需要下载模型
npm run download-wasm
npm run build
```

然后 Chrome → 扩展程序 → 加载已解压的扩展 → 选择 `dist/` 目录。

## 技术栈

- **识别引擎**: [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx/) WASM 离线推理
- **模型**: Zipformer 中英双语（INT8 量化）
- **架构**: Chrome Extension Manifest V3

## 鸣谢

- [Loser123zbx](https://github.com/Loser123zbx) — Logo 设计
- [jxlpzqc/TMSpeech](https://github.com/jxlpzqc/TMSpeech) — 项目灵感来源
- [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx/) — 离线语音识别引擎
- [Zipformer](https://github.com/k2-fsa/sherpa-onnx/) — 中英双语识别模型

## 许可证

MIT License © 2026 hcz1017
