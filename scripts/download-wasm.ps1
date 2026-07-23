param(
  [switch]$Lite,
  [string]$Version = "1.13.4",
  [string]$BuilderTag = "build-20260723-1231"
)

$model = "zipformer-bilingual-zh-en-2023-02-20"
$base = "sherpa-onnx-wasm-simd-v${Version}-${model}"

if ($Lite) {
  $url = "https://github.com/Huchangzhi/TMSpeech-wasm-builder/releases/download/${BuilderTag}/${base}-lite.tar.bz2"
  Write-Host "下载 WASM lite v${Version} (${BuilderTag})..." -ForegroundColor Yellow
} else {
  $url = "https://github.com/Huchangzhi/TMSpeech-wasm-builder/releases/download/${BuilderTag}/${base}.tar.bz2"
  Write-Host "下载 WASM full v${Version} (${BuilderTag})..." -ForegroundColor Yellow
}

$out = "$env:TEMP\wasm.tar.bz2"
$tmpDir = "$env:TEMP\wasm-extract"
$target = "public/wasm"

if (Test-Path "$target/sherpa-onnx-wasm-main-asr.data") {
  Write-Host "WASM 已存在，跳过下载" -ForegroundColor Green
  exit 0
}

curl.exe -L -o $out $url
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Remove-Item -Force -Recurse $tmpDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
New-Item -ItemType Directory -Force -Path $target | Out-Null

tar -xjf $out -C $tmpDir
Remove-Item $out -Force

Get-ChildItem -Recurse -File $tmpDir | Move-Item -Destination $target -Force
Remove-Item -Recurse -Force $tmpDir

Remove-Item -Force "$target/index.html", "$target/app-asr.js" -ErrorAction SilentlyContinue

Write-Host "完成" -ForegroundColor Green
Get-ChildItem $target | Select-Object Name, Length
