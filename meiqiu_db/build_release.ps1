$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $projectRoot

$python = 'C:\Users\92933\AppData\Local\Programs\Python\Python314\python.exe'
$dist = Join-Path $projectRoot 'dist'
$stage = Join-Path $dist 'mqdb'
$stageExe = Join-Path $stage 'mqdb.exe'
$stageInternal = Join-Path $stage '_internal'
$distExe = Join-Path $dist 'mqdb.exe'
$distInternal = Join-Path $dist '_internal'
$oldZip = Join-Path $dist 'mqdb_onedir.zip'

& $python -m PyInstaller --clean --noconfirm meiqiu_db.spec
if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller build failed. Exit code: $LASTEXITCODE"
}
if (-not (Test-Path -LiteralPath $stageExe) -or -not (Test-Path -LiteralPath $stageInternal)) {
    throw 'PyInstaller output folder dist\mqdb was not found.'
}

# Remove generated program files only; preserve user data files in dist.
if (Test-Path -LiteralPath $distExe) {
    Remove-Item -LiteralPath $distExe -Force
}
if (Test-Path -LiteralPath $distInternal) {
    Remove-Item -LiteralPath $distInternal -Recurse -Force
}
if (Test-Path -LiteralPath $oldZip) {
    Remove-Item -LiteralPath $oldZip -Force
}

Move-Item -LiteralPath $stageExe -Destination $distExe -Force
Move-Item -LiteralPath $stageInternal -Destination $distInternal -Force
Remove-Item -LiteralPath $stage -Recurse -Force

Write-Host ''
Write-Host 'Build complete:' -ForegroundColor Green
Write-Host "  $distExe"
Write-Host "  $distInternal"
Write-Host 'User configuration is read from the folder next to mqdb.exe.'
