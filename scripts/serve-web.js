#!/usr/bin/env node
// 纯 Web 版本地预览服务：静态托管 + 跨源隔离响应头。
//
// 为什么需要它：sherpa-onnx 的 wasm 是 pthreads 构建，必须处于 crossOriginIsolated
// 才能跑（共享内存）。生产环境靠 dist-web/coi-serviceworker.js 在客户端补头，
// 但开发时用带头的本地服务更省事——省掉 Service Worker 首次注册的那次自动刷新，
// 也便于用 DevTools 看清 wasm/pthread 的真实行为。
//
// 用法：
//   npm run build:web
//   node scripts/serve-web.js            # http://127.0.0.1:8000
//   node scripts/serve-web.js 8080       # 指定端口
//
// 注意：模型 .data 不在构建产物里（GitHub Pages 单文件 100MB 上限）。
// 本地想跑通完整识别，二选一：
//   ① 把 public/wasm/sherpa-onnx-wasm-main-asr.data 拷进 dist-web/wasm/（等价自打包完整版）；
//   ② 打开页面后点「开始」，用面板里的「一键下载模型」拉一次（存 IndexedDB）。
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'dist-web');
const PORT = Number(process.argv[2]) || 8000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
  console.error(`找不到 ${ROOT}/index.html —— 请先执行 npm run build:web`);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  let filePath = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
  // 防目录穿越：解析后必须仍在产物目录内
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 ' + urlPath);
    return;
  }
  const stat = fs.statSync(filePath);
  const headers = {
    'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
    'Content-Length': stat.size,
    // —— 跨源隔离：这两条是 wasm 能初始化的前提 ——
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    // 允许跨源读取（模型从 ModelScope 下载是普通 CORS 请求，不受此约束；这里只为放宽）
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Cache-Control': 'no-store',
  };
  // Range 支持：412MB 的 .data 走完整 GET 也可以，但浏览器 DevTools 里分段看更友好
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Number(m[2]) : stat.size - 1;
      res.writeHead(206, {
        ...headers,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }
  }
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`易字幕 Web 版预览： http://127.0.0.1:${PORT}/`);
  console.log('（已下发 COOP/COEP，页面处于跨源隔离，语音识别可直接启动）');
});
