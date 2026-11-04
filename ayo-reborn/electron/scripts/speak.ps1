# Rita TTS — Windows SAPI via .NET System.Speech, zero extra installs.
param(
  [Parameter(Mandatory=$true)][string]$TextFile,
  [int]$Rate = 1
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech | Out-Null
$text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $synth.Rate = [Math]::Max(-10, [Math]::Min(10, $Rate))
  $synth.Speak($text)
} finally {
  $synth.Dispose()
}
