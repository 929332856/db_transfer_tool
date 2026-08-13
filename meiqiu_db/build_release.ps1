param(
    [string]$PythonPath = ''
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $projectRoot

if ($PythonPath) {
    $pythonExe = (Resolve-Path -LiteralPath $PythonPath).Path
    $pythonArgs = @()
} else {
    # WindowsApps\python.exe 可能只是 Microsoft Store 别名，调用时会返回 9009。
    # 优先使用 Python Launcher，并解析出真正的解释器路径。
    $launcherPath = $null
    $launcherCommand = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($launcherCommand) {
        $launcherPath = $launcherCommand.Source
    } else {
        $localLauncher = Join-Path $env:LOCALAPPDATA 'Programs\Python\Launcher\py.exe'
        if (Test-Path -LiteralPath $localLauncher -PathType Leaf) {
            $launcherPath = $localLauncher
        }
    }
    if ($launcherPath) {
        $pythonExe = (& $launcherPath -3 -c "import sys; print(sys.executable)").Trim()
        $pythonArgs = @()
    } else {
        $pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
        if ($pythonCommand) {
            $pythonExe = $pythonCommand.Source
            $pythonArgs = @()
        }
    }
    if (-not $pythonExe) {
        throw 'Python not found. Pass -PythonPath C:\path\to\python.exe or add Python to PATH.'
    }
}
if (-not (Test-Path -LiteralPath $pythonExe -PathType Leaf)) {
    throw "Python executable not found: $pythonExe"
}
$pyInstallerVersion = & $pythonExe @pythonArgs -c "import PyInstaller; print(PyInstaller.__version__)"
if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller is not installed for this Python: $pythonExe. Run `& '$pythonExe' -m pip install -r requirements-dev.txt`."
}
Write-Host "Using Python: $pythonExe $($pythonArgs -join ' ')"
Write-Host "Using PyInstaller: $pyInstallerVersion"
$dist = Join-Path $projectRoot 'dist'
$stage = Join-Path $dist 'mqdb'
$stageExe = Join-Path $stage 'mqdb.exe'
$stageInternal = Join-Path $stage '_internal'
$distExe = Join-Path $dist 'mqdb.exe'
$distInternal = Join-Path $dist '_internal'
$oldZip = Join-Path $dist 'mqdb_onedir.zip'

# PyInstaller 配置集中在本脚本中，避免额外维护 .spec 文件。
$collectSubmodules = @('eel','sqlalchemy','MySQLdb','bottle','psycopg2','oracledb','pymssql','redis','cryptography','flask','waitress','webview')
$collectData = @('eel','sqlalchemy','MySQLdb','bottle','psycopg2','oracledb','pymssql','redis')
$hiddenImports = @('db_transfer_eel','modules','modules.config_state','modules.table_ops','modules.table_design','modules.transfer_engine','modules.export_import','modules.db_manage','modules.redis_ops','modules.datagrip_import','modules.tree_manager')
$extraDatas = @('web;web','app;app','db_transfer_eel.py;.','modules;modules')
$excludedModules = @('customtkinter', 'matplotlib', 'numpy', 'pandas', 'PIL')

$pyinstallerArgs = @(
    '--clean', '--noconfirm', '--onedir', '--windowed',
    '--name', 'mqdb', '--icon', 'web/mqdb.ico'
)
foreach ($package in $collectSubmodules) { $pyinstallerArgs += @('--collect-submodules', $package) }
foreach ($package in $collectData) { $pyinstallerArgs += @('--collect-data', $package) }
foreach ($module in $hiddenImports) { $pyinstallerArgs += @('--hidden-import', $module) }
foreach ($data in $extraDatas) { $pyinstallerArgs += @('--add-data', $data) }
foreach ($module in $excludedModules) { $pyinstallerArgs += @('--exclude-module', $module) }
$pyinstallerArgs += 'main.py'

& $pythonExe @pythonArgs -m PyInstaller @pyinstallerArgs
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
