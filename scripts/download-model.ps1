param(
  [string]$OutDir = "../public/models/zipformer"
)

$ModelDir = Resolve-Path (Join-Path $PSScriptRoot $OutDir)
New-Item -ItemType Directory -Path $ModelDir -Force | Out-Null

Write-Host "=== 从 ModelScope 下载 Zipformer 模型 ==="

# 使用 git clone (跳过 LFS 指针, 手动下载 ONNX 大文件)
$RepoUrl = "https://www.modelscope.cn/pengzhendong/sherpa-onnx-streaming-zipformer-bilingual-zh-en.git"
$CloneDir = Join-Path $env:TEMP "sherpa-onnx-model-tmp"

if (Test-Path $CloneDir) {
  Remove-Item -Recurse -Force $CloneDir
}

Write-Host "1/5 克隆仓库..."
git clone --depth 1 $RepoUrl $CloneDir 2>&1

if (-not (Test-Path $CloneDir)) {
  Write-Host "git clone 失败, 尝试用 modelscope CLI..."
  pip install modelscope -q
  modelscope download --model pengzhendong/sherpa-onnx-streaming-zipformer-bilingual-zh-en --local_dir $CloneDir
}

Write-Host "2/5 拷贝 tokens.txt..."
Copy-Item (Join-Path $CloneDir "tokens.txt") (Join-Path $ModelDir "tokens.txt") -Force

Write-Host "3/5 下载 encoder.onnx..."
$EncoderUrl = "https://www.modelscope.cn/pengzhendong/sherpa-onnx-streaming-zipformer-bilingual-zh-en/resolve/master/encoder-epoch-99-avg-1.onnx"
Invoke-WebRequest -Uri $EncoderUrl -OutFile (Join-Path $ModelDir "encoder.onnx") -UseBasicParsing

Write-Host "4/5 下载 decoder.onnx..."
$DecoderUrl = "https://www.modelscope.cn/pengzhendong/sherpa-onnx-streaming-zipformer-bilingual-zh-en/resolve/master/decoder-epoch-99-avg-1.onnx"
Invoke-WebRequest -Uri $DecoderUrl -OutFile (Join-Path $ModelDir "decoder.onnx") -UseBasicParsing

Write-Host "5/5 下载 joiner.onnx..."
$JoinerUrl = "https://www.modelscope.cn/pengzhendong/sherpa-onnx-streaming-zipformer-bilingual-zh-en/resolve/master/joiner-epoch-99-avg-1.onnx"
Invoke-WebRequest -Uri $JoinerUrl -OutFile (Join-Path $ModelDir "joiner.onnx") -UseBasicParsing

Remove-Item -Recurse -Force $CloneDir -ErrorAction SilentlyContinue

Write-Host "=== 下载完成 ==="
Get-ChildItem $ModelDir | Select-Object Name, Length
