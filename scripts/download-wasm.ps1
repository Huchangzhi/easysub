param(
  [string]$Version = "1.13.4"
)

$url = "https://github.com/k2-fsa/sherpa-onnx/releases/download/v${Version}/sherpa-onnx-wasm-simd-v${Version}-zh-en-asr-zipformer.tar.bz2"
$out = "wasm.tar.bz2"
$target = "public/wasm"

if (Test-Path "$target/sherpa-onnx-wasm-main-asr.data") {
  Write-Host "WASM 已存在，跳过下载" -ForegroundColor Green
  exit 0
}

Write-Host "下载 sherpa-onnx WASM v${Version}..." -ForegroundColor Yellow
curl.exe -L -o $out $url
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

New-Item -ItemType Directory -Force -Path $target | Out-Null
tar -xjf $out -C $target
Remove-Item $out -Force

Write-Host "完成" -ForegroundColor Green
