# Prepares and launches Frost Tracker from VS Code.
#  - installs node_modules if missing
#  - repairs the Electron binary when its installer failed to unzip (happens on newer Node versions)
#  - checks the Riot login helper script is present
#  - clears ELECTRON_RUN_AS_NODE (set by VS Code) so Electron starts as an app, not as Node
param([switch]$PrepareOnly)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Test-Path "$root\node_modules")) {
  Write-Host "Installing dependencies..."
  npm install
  if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
}

$electronDir = "$root\node_modules\electron"
if (-not (Test-Path "$electronDir\dist\electron.exe")) {
  Write-Host "Electron binary missing - downloading..."
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  if (Test-Path "$electronDir\dist") { Remove-Item "$electronDir\dist" -Recurse -Force }
  node "$electronDir\install.js"

  if (-not (Test-Path "$electronDir\dist\electron.exe")) {
    $version = (Get-Content "$electronDir\package.json" -Raw | ConvertFrom-Json).version
    $zip = Get-ChildItem "$env:LOCALAPPDATA\electron\Cache" -Recurse -Filter "electron-v$version-win32-x64.zip" -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if (-not $zip) { throw "Electron v$version download not found in cache; check your network and retry." }
    Write-Host "Extracting $($zip.Name) manually..."
    if (Test-Path "$electronDir\dist") { Remove-Item "$electronDir\dist" -Recurse -Force }
    Expand-Archive -Path $zip.FullName -DestinationPath "$electronDir\dist" -Force
  }
  [IO.File]::WriteAllText("$electronDir\path.txt", "electron.exe")
}

$helper = "$root\scripts\fill-riot-login.ps1"
if (-not (Test-Path $helper)) {
  $installed = "$env:LOCALAPPDATA\Programs\frost-tracker\resources\scripts\fill-riot-login.ps1"
  if (Test-Path $installed) {
    New-Item -ItemType Directory -Force "$root\scripts" | Out-Null
    Copy-Item $installed $helper
    Write-Host "Copied Riot login helper from the installed app."
  } else {
    Write-Warning "scripts\fill-riot-login.ps1 is missing; 'Open & fill Riot Client' will not work."
  }
}

if ($PrepareOnly) { exit 0 }

Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
& "$electronDir\dist\electron.exe" $root
