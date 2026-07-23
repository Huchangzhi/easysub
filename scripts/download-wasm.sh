#!/bin/bash
set -euo pipefail

LITE=false
VERSION="1.13.4"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --lite) LITE=true; shift ;;
    --version) VERSION="$2"; shift 2 ;;
    *) VERSION="$1"; shift ;;
  esac
done

if [ "$LITE" = true ]; then
  URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/v${VERSION}/sherpa-onnx-wasm-simd-v${VERSION}-zh-en-asr-zipformer.tar.bz2"
  echo "Downloading sherpa-onnx WASM lite v${VERSION}..."
else
  URL="https://github.com/Huchangzhi/TMSpeech-wasm-builder/releases/download/v1.0.0/sherpa-onnx-wasm-simd-v1.13.4-zipformer-bilingual-zh-en-2023-02-20.tar.bz2"
  echo "Downloading sherpa-onnx WASM full..."
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
echo "Done"
ls -lh "$TARGET"
