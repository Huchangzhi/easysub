/*! coi-serviceworker —— 让静态托管页面获得跨源隔离（crossOriginIsolated）。
 *
 * 为什么 web 版需要它：sherpa-onnx 的 wasm 是 **pthreads 构建**
 * （loader 里 `new WebAssembly.Memory({ shared: true })` + 4 个 em-pthread worker），
 * 共享内存的 postMessage 转移要求 `self.crossOriginIsolated === true`。
 * 扩展侧的 offscreen 文档天然满足（chrome-extension:// 页面豁免此限制），
 * 但普通网页必须由服务端下发两个响应头才能拿到：
 *     Cross-Origin-Opener-Policy: same-origin
 *     Cross-Origin-Embedder-Policy: require-corp
 * GitHub Pages / 大部分静态托管**不允许自定义响应头**，所以用这个 Service Worker
 * 在客户端给同源响应补上这两个头 —— 页面被它接管后即进入跨源隔离，SAB 可用。
 *
 * 部署提示：本文件必须与 index.html 同目录、同源。首次访问会注册 SW 并自动刷新一次
 * （这是必然的一次性代价），之后页面即为隔离状态。
 * 若托管方支持自定义头（Cloudflare Pages / Netlify / 自建 nginx），优先用响应头方案，
 * 本文件检测到已隔离会直接空转，不会重复刷新。
 *
 * 协议：MIT（同 coi-serviceworker 上游做法）
 */
if (typeof window === 'undefined') {
  // ---- Service Worker 侧：给同源响应补 COOP/COEP ----
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

  const coiHeaders = (headers) => {
    const h = new Headers(headers);
    // 用 require-corp 而不是 credentialless：本页只有同源静态资源（脚本/wasm/worker/
    // 工作线程都是同源），唯一跨源动作是 fetch() 直接下载识别模型（CORS 请求，不受
    // COEP 的 CORP 约束）。require-corp 在 Chrome/Firefox 都被稳定支持，
    // 而 credentialless 在 Firefox 上不支持、会让页面进不了隔离态。
    h.set('Cross-Origin-Embedder-Policy', 'require-corp');
    h.set('Cross-Origin-Opener-Policy', 'same-origin');
    h.set('Cross-Origin-Resource-Policy', 'cross-origin');
    return h;
  };

  self.addEventListener('fetch', (event) => {
    const req = event.request;
    // 只处理同源 GET：跨源请求（模型下载等）必须原样放行，否则会破坏对方的 CORS 语义
    const url = new URL(req.url);
    if (req.method !== 'GET' || url.origin !== self.location.origin) return;
    // Range 请求（大文件分片）不改写：包一层 Response 会丢掉 206 语义
    if (req.headers.has('range')) return;

    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        // 只改成功的同源响应；opaqueredirect 等特殊响应不能重建
        if (res.status === 0 || res.type === 'opaqueredirect') return res;
        return new Response(res.body, {
          status: res.status,
          statusText: res.statusText,
          headers: coiHeaders(res.headers),
        });
      } catch (e) {
        // 网络失败：交回浏览器的默认错误，不要伪造响应
        return fetch(req);
      }
    })());
  });
} else {
  // ---- 页面侧：按需注册并刷新一次 ----
  // 刷新次数上限：SW 激活/接管有竞态，偶尔会出现"已被控制但仍未隔离"（那一次导航的响应
  // 没被 SW 拦截）——此时需要再刷一次。用 sessionStorage 计数兜底，避免极端情况下无限刷新。
  const RELOAD_KEY = '__easysub_coi_reloads';
  const MAX_RELOADS = 3;

  function reloadOnce(reason) {
    let n = 0;
    try { n = Number(sessionStorage.getItem(RELOAD_KEY)) || 0; } catch { /* 隐私模式读不到 */ }
    if (n >= MAX_RELOADS) {
      console.warn('[EasySub] 跨源隔离仍未生效，已停止自动刷新（' + reason + '）');
      return;
    }
    try { sessionStorage.setItem(RELOAD_KEY, String(n + 1)); } catch { /* 同上 */ }
    window.location.reload();
  }

  (async function () {
    if (window.crossOriginIsolated) {
      // 已隔离：清掉计数，让下一次"环境变化"（如换托管）仍能自动修复
      try { sessionStorage.removeItem(RELOAD_KEY); } catch { /* 忽略 */ }
      return;
    }
    if (!window.isSecureContext) return;         // http:// 非本机：SW 本就不可用
    if (!('serviceWorker' in navigator)) return;

    const script = document.currentScript;
    if (!script || !script.src) return;

    // 已被 SW 控制却仍未隔离：说明本次导航的响应没走到 fetch 处理器（激活竞态）。
    // 直接再刷一次即可——此时 SW 已 active 且已 claim，下一次导航必被接管。
    if (navigator.serviceWorker.controller) { reloadOnce('already-controlled'); return; }

    try {
      const reg = await navigator.serviceWorker.register(script.src, { scope: './' });
      // 首次注册：SW 尚未接管本页 → 刷新一次让它接管
      if (reg.active) reloadOnce('worker-active');
      else navigator.serviceWorker.addEventListener('controllerchange', () => reloadOnce('controllerchange'));
    } catch (e) {
      // 注册失败（隐私模式 / 非 https / 托管策略）：页面仍可打开，只是音频采集会缺 SAB。
      // 真实原因由页面侧的安全上下文/隔离检查提示给用户，这里不重复弹窗。
      console.warn('[EasySub] 跨源隔离 Service Worker 注册失败:', e);
    }
  })();
}
