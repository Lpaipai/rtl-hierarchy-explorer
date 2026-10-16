# 2026/10/16 19:30:18 by liaoweipeng1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$bitmap = [System.Drawing.Bitmap]::new(256, 256)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$pen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#5EEAD4'), 8)
$brush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#183C50'))

try {
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.Clear([System.Drawing.ColorTranslator]::FromHtml('#102235'))

    # 与活动栏图标沿用同一个父节点连接三个子节点的形状。
    $graphics.DrawLine($pen, 128, 90, 128, 140)
    $graphics.DrawLine($pen, 48, 140, 208, 140)
    foreach ($x in @(48, 128, 208)) {
        $graphics.DrawLine($pen, $x, 140, $x, 170)
        $graphics.FillRectangle($brush, $x - 24, 170, 48, 42)
        $graphics.DrawRectangle($pen, $x - 24, 170, 48, 42)
    }
    $graphics.FillRectangle($brush, 92, 42, 72, 48)
    $graphics.DrawRectangle($pen, 92, 42, 72, 48)

    $output = Join-Path $PSScriptRoot '..\media\icon.png'
    $bitmap.Save($output, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Output "已生成商店图标：$output"
}
finally {
    $brush.Dispose()
    $pen.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
}
