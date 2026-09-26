# 易字幕 / EasySub

<p>
  <img src="logo.jpg" width="64" height="64" style="border-radius:12px;">
</p>

免费、安全的基于本地模型的实时字幕浏览器扩展。

[目前已上架微软插件市场](https://microsoftedge.microsoft.com/addons/detail/elphdofjlfpccfkcfaamkodcniemecao)


## 简介

易字幕 是一款完全离线的浏览器扩展，无需注册、无需联网、无需上传任何数据。通过 WASM 在本地运行语音识别模型，在浏览任意网页时实时生成字幕。

- **免费** — 无付费，无订阅
- **安全** — 所有计算在本地完成，音频数据不上传
- **离线** — 模型加载后可离线使用
- **实时** — 低延迟流式识别，说话即现

## 使用

1. 安装扩展后，点击浏览器工具栏的图标打开面板
2. 点击 **开始** 按钮
3. 当前标签页播放的音频会实时生成字幕叠加层
4. 字幕层操作：
   - 拖动调整位置；**锁定**后只剩纯文字（锁定状态持久记忆，重启后不丢）
   - 点左上角箭头**回看最近 10 句**——走神漏看时立即补看，锁定状态下也可用
   - 右下角**延迟指示器**：🟢 优秀 <200ms ｜ 🟡 中 <1s ｜ 🔴 高 ≥1s（建议检查设备资源占用）；未锁定时直接显示实时毫秒数，锁定后收起为色点、悬停查看状态
5. 面板功能：
   - **搜索**历史字幕：实时过滤 + 命中高亮 + 命中计数
   - 较高级的设置项旁有 **？** 图标，悬停查看中英双语详细说明
   - 近句回看与延迟指示器均可在面板中**开关**（默认开启，关闭后零性能开销）

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

### 纯 Web 版

同一份源码还能构建出一个**不依赖任何扩展 API 的静态网页版**，可以直接扔到 GitHub Pages、
对象存储或任意静态服务器上（`npm run build:web` → `dist-web/`）：

```bash
npm run build:web
# dist-web/ 即为可托管的静态站点；本地预览：
npx serve dist-web        # 或 python -m http.server -d dist-web
```

```bash
cd dist-web && python -m http.server 8000   # 然后访问 http://localhost:8000
```

Web 版与扩展版的差别只有三处，识别引擎、标点、翻译、字幕层、控制面板全部是同一份代码：

| | 扩展版 | Web 版 |
|---|---|---|
| 音频来源 | 当前标签页 / 系统音频 / 麦克风 | 系统音频 / 麦克风 |
| 字幕显示 | 页内叠加层，或悬浮字幕窗 | 字幕浮窗（可置顶，`window.open` 独立窗口） |
| 识别模型 | 包内自带（full/lite）或首次导入 | 首次使用时一键下载或手动导入（存 IndexedDB，之后长期有效） |

> ⚠️ **Web 版必须处于「跨源隔离」状态**。sherpa-onnx 的 wasm 是 pthreads 构建
> （共享内存 + worker），没有 `crossOriginIsolated` 连初始化都会抛 `DataCloneError`。
> 具体见下方「跨源隔离」一节。

#### 跨源隔离（Web 版部署必读）

普通网页需要服务端下发两个响应头才能进入隔离态：

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

**GitHub Pages 等静态托管不允许自定义响应头**，所以 `dist-web/` 里带了一个
`coi-serviceworker.js`：它注册一个 Service Worker，在客户端给同源响应补上这两个头。
首次访问会自动刷新一次（Service Worker 接管后才生效），之后页面即为隔离态。
用户无需任何操作。

如果托管方支持自定义头（Cloudflare Pages / Netlify / 自建 nginx），直接用响应头即可，
`coi-serviceworker.js` 检测到已隔离会自动空转，不会重复刷新。nginx 示例：

```nginx
add_header Cross-Origin-Opener-Policy same-origin;
add_header Cross-Origin-Embedder-Policy require-corp;
```

页面加载时会自检这两个条件，不合格就在说明区直接显示原因与处理办法（不会静默失败）。

#### Web 版与本仓库的长期共存

新增功能请优先加在共享层，两端自动都有：

- 面板 UI：`src/ui-body.html` + `src/ui.css`（扩展 popup 与 Web 面板共用同一份模板），
  逻辑在 `src/panel.ts`
- 字幕浮窗：`src/subtitle-shell.html` + `src/subtitle-shell.css` + `src/subtitle-shell.ts`
- 识别引擎：`src/asr-engine.ts`（含 ASR / 标点 / 翻译队列 / 音频采集 / 延迟与电平测量）
- 字幕记录：`src/transcript-store.ts`
- 宿主差异：`src/platform.ts`（storage / URL / 消息总线）+ `src/web/`（Web 宿主接线）

只有真的需要 `chrome.*` 时才在 `src/platform.ts` 里加封装或按 `IS_EXTENSION` 分支；
**不要在共享模块里直接调 `chrome.*`**，否则 Web 版会跟着一起坏。

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

### 代码结构（两版共用）

```
src/
  platform.ts        宿主差异的唯一收口（storage / URL 解析 / 消息总线 / 能力探测）
  asr-engine.ts      识别引擎：ASR + 标点 + 翻译优先级队列 + 音频采集 + 延迟/电平测量
  mic-capture.ts     麦克风采集（16k 单声道定长出块），两端共用
  transcript-store.ts 字幕记录持久化（串行写队列 + 裁剪 + 译文按 seq 归位）
  subtitle-shell.ts  字幕浮窗外壳（叠层 + 工具条 + 画中画置顶），两端共用
  overlay.ts         字幕叠层本体（拖拽/锁定/回看/延迟指示/译文行）
  panel.ts           控制面板逻辑            ┐ 与 ui-body.html + ui.css
  ui-body.html       控制面板 DOM（两端同一份）├ 组成两端的面板
  ui.css             控制面板样式            ┘
  background.ts      扩展：SW 路由 / offscreen 与悬浮窗生命周期（Web 版无此角色）
  offscreen.ts       扩展：只做端口接线，引擎在 asr-engine.ts
  floating.ts        扩展：悬浮字幕窗宿主（mic 采集端也在这里）
  popup.ts           扩展：弹窗入口，只负责挂载 panel.ts
  web/panel.ts       纯 Web：面板入口 + 屏幕共享预取 + 字幕浮窗开合
  web/host.ts        纯 Web：扮演 background + offscreen 的角色（同页承载引擎）
  web/subtitle.ts    纯 Web：字幕浮窗宿主
  web/channel.ts     纯 Web：面板 ↔ 浮窗的跨窗口消息通道（postMessage + 心跳握手）
web-static/
  coi-serviceworker.js  Web 版跨源隔离垫片（静态托管无法下发 COOP/COEP）
```

### 数据流

1. **音频捕获**: AudioWorklet（`audio-worklet-processor.js`）在独立音频线程读取 tab 音频
2. **缓冲**: 主线程定时（60ms）从 AudioWorklet 拉取累积音频帧；Web 版另有一条 AudioWorklet
   主动 push 路径（`audio-worklet-processor.js` 里的"双模式出块"），避免后台标签页定时器被节流
3. **ASR 解码**: `pipeline.feedAudio()` → sherpa-onnx `acceptWaveform()` + `decode()`
4. **流式文本**: `onTextChanged` → 立即送显示 → `setTimeout(0)` 触发标点恢复
5. **标点恢复**: CT-Transformer 模型推理（同步阻塞主线程），AudioWorklet 继续缓冲不丢帧
6. **句完成**: `onSentenceDone` → 终版标点 → 追加到字幕记录 → 清理缓存
7. **显示**: content script 收到文本 → 更新叠加层（流式标点/终版标点）
8. **延迟测量**: offscreen 以 EMA 统计「flush RTT + 解码耗时」，每 ≥2s 推送至字幕层右下角指示器

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

## Star 趋势

[![Star History Chart](https://api.star-history.com/svg?repos=Huchangzhi/easysub&type=Date)](https://star-history.com/#Huchangzhi/easysub&Date)
