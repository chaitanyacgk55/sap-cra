# Creates a desktop shortcut so you can double-click to launch SAP Code Reviewer.
# Run once: right-click → "Run with PowerShell"

$scriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Definition
$target     = Join-Path $scriptDir 'start.cmd'
$desktop    = [Environment]::GetFolderPath('Desktop')
$shortcut   = Join-Path $desktop 'SAP Code Reviewer.lnk'
$iconSrc    = 'C:\Windows\System32\shell32.dll'  # built-in Windows icon library
$iconIndex  = 13                                  # magnifying-glass / search icon

$wsh  = New-Object -ComObject WScript.Shell
$lnk  = $wsh.CreateShortcut($shortcut)
$lnk.TargetPath       = 'cmd.exe'
$lnk.Arguments        = "/c `"$target`""
$lnk.WorkingDirectory = $scriptDir
$lnk.WindowStyle      = 1          # 1 = Normal window
$lnk.Description      = 'Launch SAP Code Reviewer (server + browser UI + Claude)'
$lnk.IconLocation     = "$iconSrc,$iconIndex"
$lnk.Save()

Write-Host ""
Write-Host "  Shortcut created: $shortcut" -ForegroundColor Green
Write-Host "  Double-click 'SAP Code Reviewer' on your desktop to start." -ForegroundColor Cyan
Write-Host ""
