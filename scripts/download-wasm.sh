#!/bin/bash
set -euo pipefail

LITE=false
VERSION="1.13.4"
# 与 download-wasm.ps1 保持一致：统一从 builder 自建的 releases 取件。
# 注意 lite 也走 builder（同一个 tag 下的 -lite 资产），不要指向 k2-fsa 上游的原始包——
# 上游包里的 sherpa-onnx-asr.js 是未打补丁的原始版，与本仓库的补丁版不是同一份。
BUILDER_TAG="build-20260723-1231"
MODEL="zipformer-bilingual-zh-en-2023-02-20"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --lite) LITE=true; shift ;;
    --version) VERSION="$2"; shift 2 ;;
    *) VERSION="$1"; shift ;;
  esac
done

BASE="sherpa-onnx-wasm-simd-v${VERSION}-${MODEL}"
if [ "$LITE" = true ]; then
  URL="https://github.com/easysub-org/easysub-wasm-builder/releases/download/${BUILDER_TAG}/${BASE}-lite.tar.bz2"
  echo "Downloading sherpa-onnx WASM lite v${VERSION} (${BUILDER_TAG})..."
else
  URL="https://github.com/easysub-org/easysub-wasm-builder/releases/download/${BUILDER_TAG}/${BASE}.tar.bz2"
  echo "Downloading sherpa-onnx WASM full v${VERSION} (${BUILDER_TAG})..."
fi

TARGET="public/wasm"

if [ -f "$TARGET/sherpa-onnx-wasm-main-asr.data" ]; then
  echo "WASM already exists, skipping"
  exit 0
fi

TMPDIR=$(mktemp -d)
curl -sL "$URL" | tar xj -C "$TMPDIR"
mkdir -p "$TARGET"
find "$TMPDIR" -type f -exec mv {} "$TARGET" \;
rm -rf "$TMPDIR"
rm -f "$TARGET/index.html" "$TARGET/app-asr.js"

# 坑：下载包里的 sherpa-onnx-asr.js / sherpa-onnx-punctuation.js 是**未打补丁的原始版**，
# 上面整包铺开会覆盖仓库里 git 跟踪的补丁版（补丁修了 config 被整体替换、module 守卫
# 缺失两个 bug，用原始版构建的产物一加载就炸）。这里必须还原，与 CI 的处理一致。
for f in sherpa-onnx-asr.js sherpa-onnx-punctuation.js; do
  if git ls-files --error-unmatch -- "$TARGET/$f" >/dev/null 2>&1; then
    git checkout -- "$TARGET/$f"
    echo "restored patched $f"
  else
    echo "WARNING: $TARGET/$f is not tracked; cannot restore the patched version" >&2
  fi
done

echo "Done"
ls -lh "$TARGET"
