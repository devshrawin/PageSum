# Zips extension\ to dist\<yyyy-mm-dd>\PageSum-v<version>.zip
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -Raw -Path (Join-Path $root 'extension\manifest.json') | ConvertFrom-Json
$version = $manifest.version
$outDir = Join-Path $root ("dist\" + (Get-Date -Format 'yyyy-MM-dd'))
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$zip = Join-Path $outDir ("PageSum-v" + $version + ".zip")
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $root 'extension\*') -DestinationPath $zip
Write-Host "Wrote $zip"
