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

# 坑：下载包里的 sherpa-onnx-asr.js / sherpa-onnx-punctuation.js 是**未打补丁的原始版**，
# 上面整包铺开会把仓库里 git 跟踪的补丁版覆盖掉（补丁修了 config 被整体替换、module 守卫
# 缺失两个 bug，用原始版构建出的产物一加载就炸）。这里必须还原，与 CI 的处理一致。
# 用 git 还原（而非脚本内置副本）：补丁版本身就是仓库里受跟踪的那一份，改它要在 git 里改。
foreach ($f in @("sherpa-onnx-asr.js", "sherpa-onnx-punctuation.js")) {
  $rel = "$target/$f"
  if (git ls-files --error-unmatch -- $rel 2>$null) {
    git checkout -- $rel
    Write-Host "已还原补丁版 $f" -ForegroundColor Cyan
  } else {
    Write-Host "警告：$f 不是 git 跟踪文件，无法还原补丁版；请确认仓库状态正常" -ForegroundColor Yellow
  }
}

Write-Host "完成" -ForegroundColor Green
Get-ChildItem $target | Select-Object Name, Length
