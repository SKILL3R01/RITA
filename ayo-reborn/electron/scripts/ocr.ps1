# Rita OCR — Windows 10/11 built-in OCR (Windows.Media.Ocr). Zero third-party install.
param(
  [Parameter(Mandatory=$true)][string]$ImageFile,
  [int]$MaxDim = 0  # 0 = use the OCR engine's own max (10000 on Win11; older builds clamp lower)
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName System.Drawing
$null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]

function Await($WinRtTask, $ResultType) {
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
  $netTask = $asTask.MakeGenericMethod($ResultType).Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

# OCR engine has a max image dimension; clamp to it (never upscale).
$max = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
if ($MaxDim -le 0) { $MaxDim = $max }
if ($max -gt 0 -and $max -lt $MaxDim) { $MaxDim = $max }
$img = [System.Drawing.Image]::FromFile($ImageFile)
$useFile = $ImageFile
if ($img.Width -gt $MaxDim -or $img.Height -gt $MaxDim) {
  $f = [Math]::Min($MaxDim / [float]$img.Width, $MaxDim / [float]$img.Height)
  $nw = [int]($img.Width * $f); $nh = [int]($img.Height * $f)
  $scaled = New-Object System.Drawing.Bitmap($nw, $nh)
  $g = [System.Drawing.Graphics]::FromImage($scaled)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($img, 0, 0, $nw, $nh)
  $g.Dispose()
  $useFile = Join-Path $env:TEMP ("rita-ocr-{0}.png" -f (Get-Random))
  $scaled.Save($useFile, [System.Drawing.Imaging.ImageFormat]::Png)
  $scaled.Dispose()
}
$img.Dispose()

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $engine) {
  try {
    $lang = New-Object Windows.Globalization.Language('en-US')
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
  } catch { }
}
if (-not $engine) {
  Write-Output 'OCR-ERR 0  (no OCR language pack installed; Settings > Time & language > Language)'
  exit 3
}

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($useFile)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$text = ($result.Lines | ForEach-Object { $_.Text }) -join [Environment]::NewLine
Write-Output "OCR-OK $($text.Length)"
Write-Output $text
