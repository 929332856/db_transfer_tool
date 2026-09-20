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
$buildDir = Join-Path $projectRoot 'build'
$distExe = Join-Path $dist 'mqdb.exe'
$distInternal = Join-Path $dist '_internal'
$oldZip = Join-Path $dist 'mqdb_onedir.zip'

# PyInstaller 配置集中在本脚本中，避免额外维护 .spec 文件。
$collectSubmodules = @('eel','sqlalchemy','MySQLdb','bottle','psycopg2','oracledb','pymssql','redis','cryptography','flask','waitress','webview')
$collectData = @('eel','sqlalchemy','MySQLdb','bottle','psycopg2','oracledb','pymssql','redis')
$hiddenImports = @('db_transfer_eel','modules','modules.config_state','modules.table_ops','modules.table_design','modules.transfer_engine','modules.export_import','modules.db_manage','modules.redis_ops','modules.datagrip_import','modules.tree_manager')
$extraDatas = @('web;web','app;app','db_transfer_eel.py;.','modules;modules')
$excludedModules = @('customtkinter', 'matplotlib', 'numpy', 'pandas', 'PIL')

# Python 3.14 stores Tcl/Tk scripts in libtcl*.zip/libtk*.zip.  PyInstaller's
# tkinter runtime hook still expects unpacked _tcl_data/_tk_data directories.
# Unpack those archives into a generated build-only directory and include them
# explicitly, otherwise the frozen program exits before main.py starts.
$tclTkStage = Join-Path $buildDir 'tcltk_data'
if (Test-Path -LiteralPath $tclTkStage) {
    Remove-Item -LiteralPath $tclTkStage -Recurse -Force
}
$tclDataDir = Join-Path $tclTkStage '_tcl_data'
$tkDataDir = Join-Path $tclTkStage '_tk_data'
New-Item -ItemType Directory -Path $tclDataDir, $tkDataDir -Force | Out-Null
$pythonHome = Split-Path -Parent $pythonExe
$pythonTclRoot = Join-Path $pythonHome 'tcl'
$tclZip = Get-ChildItem -LiteralPath $pythonTclRoot -Filter 'libtcl*.zip' -File -ErrorAction SilentlyContinue | Select-Object -First 1
$tkZip = Get-ChildItem -LiteralPath $pythonTclRoot -Filter 'libtk*.zip' -File -ErrorAction SilentlyContinue | Select-Object -First 1
if ($tclZip -and $tkZip) {
    $tclExtract = Join-Path $tclTkStage '_tcl_extract'
    $tkExtract = Join-Path $tclTkStage '_tk_extract'
    Expand-Archive -LiteralPath $tclZip.FullName -DestinationPath $tclExtract -Force
    Expand-Archive -LiteralPath $tkZip.FullName -DestinationPath $tkExtract -Force
    Get-ChildItem -LiteralPath (Join-Path $tclExtract 'tcl_library') -Force | ForEach-Object {
        Move-Item -LiteralPath $_.FullName -Destination $tclDataDir -Force
    }
    Get-ChildItem -LiteralPath (Join-Path $tkExtract 'tk_library') -Force | ForEach-Object {
        Move-Item -LiteralPath $_.FullName -Destination $tkDataDir -Force
    }
} else {
    # Older Python installations may already ship unpacked directories.
    $tclSourceDir = Get-ChildItem -LiteralPath $pythonTclRoot -Directory -Filter 'tcl*' -ErrorAction SilentlyContinue | Select-Object -First 1
    $tkSourceDir = Get-ChildItem -LiteralPath $pythonTclRoot -Directory -Filter 'tk*' -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $tclSourceDir -or -not $tkSourceDir) {
        throw "Tcl/Tk runtime data was not found under $pythonTclRoot"
    }
    Get-ChildItem -LiteralPath $tclSourceDir.FullName -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $tclDataDir -Recurse -Force
    }
    Get-ChildItem -LiteralPath $tkSourceDir.FullName -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $tkDataDir -Recurse -Force
    }
}
$extraDatas += ($tclDataDir + ';_tcl_data')
$extraDatas += ($tkDataDir + ';_tk_data')

$pyinstallerArgs = @(
    '--clean', '--noconfirm', '--onefile', '--windowed',
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
if (-not (Test-Path -LiteralPath $distExe)) {
    throw 'PyInstaller output file dist\mqdb.exe was not found.'
}

# Remove generated program directories only; preserve user data files in dist.
if (Test-Path -LiteralPath $distInternal) {
    Remove-Item -LiteralPath $distInternal -Recurse -Force
}
if (Test-Path -LiteralPath $oldZip) {
    Remove-Item -LiteralPath $oldZip -Force
}
if (Test-Path -LiteralPath $buildDir) {
    Remove-Item -LiteralPath $buildDir -Recurse -Force
}

Write-Host ''
Write-Host 'Build complete:' -ForegroundColor Green
Write-Host "  $distExe"
Write-Host 'User configuration is read from the folder next to mqdb.exe.'
