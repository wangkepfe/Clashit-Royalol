param(
  [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [int]$Width = 896,
  [int]$Height = 1200
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

Add-Type -ReferencedAssemblies 'System.Drawing' -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class CardMasker
{
    public static void Apply(Bitmap image, Bitmap mask)
    {
        Rectangle rect = new Rectangle(0, 0, image.Width, image.Height);
        BitmapData imageData = image.LockBits(rect, ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
        BitmapData maskData = mask.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);

        try
        {
            int imageStride = Math.Abs(imageData.Stride);
            int maskStride = Math.Abs(maskData.Stride);
            int imageBytes = imageStride * image.Height;
            int maskBytes = maskStride * mask.Height;
            byte[] imageBuffer = new byte[imageBytes];
            byte[] maskBuffer = new byte[maskBytes];

            Marshal.Copy(imageData.Scan0, imageBuffer, 0, imageBytes);
            Marshal.Copy(maskData.Scan0, maskBuffer, 0, maskBytes);

            for (int y = 0; y < image.Height; y++)
            {
                int imageRow = imageData.Stride >= 0 ? y * imageData.Stride : (image.Height - 1 - y) * imageStride;
                int maskRow = maskData.Stride >= 0 ? y * maskData.Stride : (mask.Height - 1 - y) * maskStride;

                for (int x = 0; x < image.Width; x++)
                {
                    int io = imageRow + (x * 4);
                    int mo = maskRow + (x * 4);

                    int mb = maskBuffer[mo + 0];
                    int mg = maskBuffer[mo + 1];
                    int mr = maskBuffer[mo + 2];
                    int ma = maskBuffer[mo + 3];
                    int maskLuma = (54 * mr + 183 * mg + 19 * mb) >> 8;
                    int maskAlpha = (ma * maskLuma) / 255;
                    int finalAlpha = (imageBuffer[io + 3] * maskAlpha) / 255;

                    imageBuffer[io + 3] = (byte)finalAlpha;
                    if (finalAlpha == 0)
                    {
                        imageBuffer[io + 0] = 0;
                        imageBuffer[io + 1] = 0;
                        imageBuffer[io + 2] = 0;
                    }
                }
            }

            Marshal.Copy(imageBuffer, 0, imageData.Scan0, imageBytes);
        }
        finally
        {
            image.UnlockBits(imageData);
            mask.UnlockBits(maskData);
        }
    }
}
"@

function New-ResizedBitmap {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][int]$TargetWidth,
    [Parameter(Mandatory = $true)][int]$TargetHeight
  )

  $source = [System.Drawing.Image]::FromFile($Path)
  try {
    $bitmap = New-Object System.Drawing.Bitmap $TargetWidth, $TargetHeight, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $bitmap.SetResolution($source.HorizontalResolution, $source.VerticalResolution)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.Clear([System.Drawing.Color]::Transparent)
      $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $graphics.DrawImage($source, 0, 0, $TargetWidth, $TargetHeight)
    } finally {
      $graphics.Dispose()
    }
    return $bitmap
  } finally {
    $source.Dispose()
  }
}

$cards = @(
  @{ Source = 'knight.png';    Output = 'knight.png' },
  @{ Source = 'archer.png';    Output = 'archers.png' },
  @{ Source = 'goblin.png';    Output = 'goblins.png' },
  @{ Source = 'giant.png';     Output = 'giant.png' },
  @{ Source = 'cannon.png';    Output = 'cannon.png' },
  @{ Source = 'musketeer.png'; Output = 'musketeer.png' },
  @{ Source = 'fireball.png';  Output = 'fireball.png' },
  @{ Source = 'arrows.png';    Output = 'arrows.png' }
)

$outDir = Join-Path $Root 'assets\cards'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$maskPath = Join-Path $Root 'mask.png'
if (-not (Test-Path -LiteralPath $maskPath)) {
  throw "Missing mask image: $maskPath"
}

$mask = New-ResizedBitmap -Path $maskPath -TargetWidth $Width -TargetHeight $Height
try {
  foreach ($card in $cards) {
    $sourcePath = Join-Path $Root $card.Source
    if (-not (Test-Path -LiteralPath $sourcePath)) {
      throw "Missing card image: $sourcePath"
    }

    $outputPath = Join-Path $outDir $card.Output
    $image = New-ResizedBitmap -Path $sourcePath -TargetWidth $Width -TargetHeight $Height
    try {
      [CardMasker]::Apply($image, $mask)
      $image.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
      Write-Host ("Wrote {0} ({1}x{2})" -f $outputPath, $Width, $Height)
    } finally {
      $image.Dispose()
    }
  }
} finally {
  $mask.Dispose()
}
