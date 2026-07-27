# Puts an AiCut shortcut on the Desktop, pointing at the launcher in this folder.
# Run with: npm run shortcut
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $root 'AiCut.cmd'
if (-not (Test-Path $launcher)) { throw "No launcher at $launcher" }

$link = Join-Path ([Environment]::GetFolderPath('Desktop')) 'AiCut.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($link)
$shortcut.TargetPath = $launcher
$shortcut.WorkingDirectory = $root
$shortcut.Description = 'AiCut video editor'

# The app's own icon. Run "npm run icon" if it is not there yet.
$icon = Join-Path $root 'build\icon.ico'
if (-not (Test-Path $icon)) { $icon = Join-Path $root 'node_modules\electron\dist\electron.exe' }
if (Test-Path $icon) { $shortcut.IconLocation = $icon }

$shortcut.Save()
Write-Host "Shortcut created: $link"
