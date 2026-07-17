#!/bin/bash
set -euo pipefail
VERSION="${1:-1.13.4}"
URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/v${VERSION}/sherpa-onnx-wasm-simd-v${VERSION}-zh-en-asr-zipformer.tar.bz2"
TARGET="public/wasm"

if [ -f "$TARGET/sherpa-onnx-wasm-main-asr.data" ]; then
  echo "WASM already exists, skipping"
  exit 0
fi

echo "Downloading sherpa-onnx WASM v${VERSION}..."
TMPDIR=$(mktemp -d)
curl -sL "$URL" | tar xj -C "$TMPDIR"
mkdir -p "$TARGET"
find "$TMPDIR" -type f -exec mv {} "$TARGET" \;
rm -rf "$TMPDIR"
rm -f "$TARGET/index.html" "$TARGET/app-asr.js"
echo "Done"
ls -lh "$TARGET"
