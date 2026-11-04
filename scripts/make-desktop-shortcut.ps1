# Create (or refresh) the desktop shortcut for OpenLeaner.
#
# IMPORTANT: the shortcut must point at the LAUNCHER (.bat), not at
# OpenLeaner.exe directly. On some Windows setups Chromium's sandbox fails
# before any JavaScript runs, and the process dies with exit code 3 while
# showing the user absolutely nothing. The launcher passes --no-sandbox,
# which is the only thing that reliably avoids that native-level crash.
#
# This script is intentionally ASCII-only and saved as UTF-8 with BOM:
# Windows PowerShell 5.1 reads BOM-less files as ANSI (GBK here), which
# corrupts non-ASCII comments and can eat the following variable
# assignments. Plain-English comments avoid that trap entirely.
#
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File make-desktop-shortcut.ps1

$ErrorActionPreference = 'Stop'

$appDir  = 'E:\openleaner\release\win-unpacked'
$exe     = Join-Path $appDir 'OpenLeaner.exe'
$bat     = Join-Path $appDir 'OpenLeaner-Launcher.bat'
$desktop = [Environment]::GetFolderPath('Desktop')
$link    = Join-Path $desktop 'OpenLeaner.lnk'

if (-not (Test-Path $exe)) {
    Write-Output "ERROR: OpenLeaner.exe not found at $exe"
    Write-Output '       Run: npx electron-builder --dir'
    exit 1
}

# Prefer the launcher; fall back to the exe only if the launcher is missing
# (the app will likely fail to start in that case, hence the warning).
if (Test-Path $bat) {
    $target = $bat
    Write-Output 'Target  : launcher (passes --no-sandbox)'
} else {
    $target = $exe
    Write-Output 'WARNING : launcher missing, pointing at the exe directly.'
    Write-Output '          The app may exit silently on this machine.'
}

Write-Output "Desktop : $desktop"
Write-Output "Target  : $target"

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($link)
$sc.TargetPath       = $target
$sc.WorkingDirectory = $appDir
$sc.Description      = 'OpenLeaner - turn course material into review slides and practice questions'
$sc.IconLocation     = "$exe,0"
$sc.Save()

if (Test-Path $link) {
    Write-Output "OK: created $link"
} else {
    Write-Output 'ERROR: shortcut creation failed'
    exit 1
}
