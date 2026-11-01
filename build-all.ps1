<#
.SYNOPSIS
Builds all three plugins - the Node plugin, the Node demo and the exe - and packages them into marketplace\.

.DESCRIPTION
Doesn't touch Stream Deck, which keeps running throughout - install.ps1 installs what this builds, separately:
  1. Builds the Node plugin and the Node demo (npm run build / npm run build:demo) and the exe plugin (CMake,
     configuring audio-switcher-exe\build the first time) into the repo's own plugin folders - with each build's
     own copy into Stream Deck's Plugins folder turned off (SYNC_TO_STREAMDECK=0), since that fails while Stream
     Deck runs.
  2. Packages all three into marketplace\ (marketplace\package.ps1). Skip with -SkipPackage.

Run it from anywhere:
  powershell -ExecutionPolicy Bypass -File build-all.ps1

Needs Node.js (with npm), CMake 3.28+ and Visual Studio 2022 with the "Desktop development with C++"
workload - see each project's README.

.PARAMETER SkipPackage
Build only, leaving marketplace\'s .streamDeckPlugin files as they are.
#>
param([switch]$SkipPackage)

$root = $PSScriptRoot

function Invoke-Step([string]$Name, [scriptblock]$Command) {
    Write-Host "`n== $Name" -ForegroundColor Cyan
    # Any error in the step (a missing command, say) stops the build, and a stale exit code from an earlier
    # step can't pass for success.
    $ErrorActionPreference = "Stop"
    $global:LASTEXITCODE = 0
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "$Name failed (exit code $LASTEXITCODE)." }
}

# npm.cmd rather than plain npm: PowerShell would pick Node's npm.ps1 shim, which garbles arguments containing
# spaces. Node.js isn't always on PATH in a new shell after installing it (e.g. with winget).
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { $env:PATH = "C:\Program Files\nodejs;" + $env:PATH }
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw "npm not found - install Node.js first." }
$cmake = (Get-Command cmake -ErrorAction SilentlyContinue).Source
if (-not $cmake) { $cmake = "C:\Program Files\CMake\bin\cmake.exe" }
if (-not (Test-Path $cmake)) { throw "CMake not found - install it, or add it to PATH." }

# Both builds read this and skip copying themselves into Stream Deck's Plugins folder; install.ps1 installs instead.
$env:SYNC_TO_STREAMDECK = "0"

Push-Location (Join-Path $root "audio-switcher-node")
try {
    if (-not (Test-Path "node_modules")) { Invoke-Step "Installing Node dependencies" { npm.cmd install } }
    Invoke-Step "Node plugin" { npm.cmd run build }
    Invoke-Step "Node demo" { npm.cmd run build:demo }
}
finally {
    Pop-Location
}

$exeDir = Join-Path $root "audio-switcher-exe"
$buildDir = Join-Path $exeDir "build"
if (-not (Test-Path (Join-Path $buildDir "CMakeCache.txt"))) {
    Invoke-Step "Configuring the exe plugin" { & $cmake -S $exeDir -B $buildDir }
}
Invoke-Step "Exe plugin" { & $cmake --build $buildDir --config RelWithDebInfo --target install --parallel }

if (-not $SkipPackage) {
    Invoke-Step "Packaging into marketplace\" { & (Join-Path $root "marketplace\package.ps1") }
}

Write-Host "`nAll three plugins built. Install them into Stream Deck with install.ps1." -ForegroundColor Green
