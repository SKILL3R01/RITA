# Rita test helper: draw digits on a white bitmap for capture/OCR/vision tests.
param([Parameter(Mandatory=$true)][string]$OutFile, [string]$Text = 'CODE 7391 RITA')
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(640, 240)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$f = New-Object System.Drawing.Font('Consolas', 72, [System.Drawing.FontStyle]::Bold)
$b = [System.Drawing.Brushes]::Black
$g.DrawString($Text, $f, $b, 40, 60)
$g.Dispose()
$bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "IMG-OK $OutFile"
