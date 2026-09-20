// ponytail: sherpa-onnx 的 pthread 胶水把预热池硬编码为 4，启动即向 worker
// postMessage 共享 WebAssembly.Memory——Firefox 扩展页非 crossOriginIsolated，
// 这一步必抛 "WebAssembly.Memory object cannot be serialized"。
// 把池子置 0 后：不预造 worker、loadWasmModuleToAllWorkers 空转、共享内存只在
// 主线程创建（FF 允许创建、只禁止转移）；sherpa v1.13.4 的 ORT 是单线程池
// （PR #3599），运行期不再 pthread_create，故可零重编译纯主线程跑。
// 天花板：若未来 sherpa 的 ORT 恢复多线程，运行期会懒 spawn（getNewWorker→postMessage），
// 再次抛错——届时只能换单线程 wasm 构建。
//
// 注意 dist 胶水已被 webpack/Terser 改名，需同时匹配两种形态：
//   production：initMainThread(){for(var e=4;e--;)PThread.allocateUnusedWorker();
//   development：initMainThread(){var pthreadPoolSize=4;while(pthreadPoolSize--){...
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const wasmDir = join(process.argv[2] ?? 'dist-firefox', 'wasm');
if (!existsSync(wasmDir)) {
  console.error(`[patch-ff-thread-mode] no such dir: ${wasmDir}`);
  process.exit(1);
}

const hasZero = (src) =>
  /pthreadPoolSize=0\b/.test(src) ||
  /for\(var \w+=\s*0;\w+--;\)PThread\.allocateUnusedWorker\(\)/.test(src);
const hasFour = (src) =>
  /pthreadPoolSize=4\b/.test(src) ||
  /for\(var \w+=\s*4;\w+--;\)PThread\.allocateUnusedWorker\(\)/.test(src);

function patch(src) {
  if (/pthreadPoolSize=4\b/.test(src)) return src.replace('pthreadPoolSize=4', 'pthreadPoolSize=0');
  return src.replace(
    /(for\(var \w+=\s*)4;(\w+--;\)PThread\.allocateUnusedWorker\(\))/g,
    (_m, a, b) => a + '0;' + b,
  );
}

const glueFiles = readdirSync(wasmDir).filter((n) => /^sherpa-onnx-wasm-main-.*\.js$/.test(n));
if (glueFiles.length === 0) {
  console.error('[patch-ff-thread-mode] no sherpa-onnx-wasm-main-*.js found');
  process.exit(1);
}

for (const name of glueFiles) {
  const file = join(wasmDir, name);
  const src = readFileSync(file, 'utf8');
  if (!/PThread/.test(src)) {
    console.log(`[patch-ff-thread-mode] ${name}: no pthread code, skip`);
    continue;
  }
  if (!hasZero(src) && !hasFour(src)) {
    console.error(`[patch-ff-thread-mode] ${name}: pool loop not found, glue form changed?`);
    process.exit(1);
  }
  const out = patch(src);
  if (out !== src) {
    writeFileSync(file, out);
    console.log(`[patch-ff-thread-mode] ${name}: pthreadPoolSize -> 0`);
  } else {
    console.log(`[patch-ff-thread-mode] ${name}: already patched, skip`);
  }
}