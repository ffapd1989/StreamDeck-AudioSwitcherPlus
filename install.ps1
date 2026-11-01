<#
.SYNOPSIS
Installs the built plugins - the Node plugin, the Node demo and the exe - into Stream Deck.

.DESCRIPTION
Copies what build-all.ps1 built (the plugin folders at the repo root) into %APPDATA%\Elgato\StreamDeck\Plugins\.
Stream Deck has to be fully quit for that - its main process holds files open in its Plugins folder, so they can't
be replaced while it runs - so this closes it, copies the plugins in, and starts it again, even if the copy failed.
A plugin that hasn't been built is left out, with a warning; if none has, Stream Deck isn't closed at all.

Run it from anywhere, after build-all.ps1:
  powershell -ExecutionPolicy Bypass -File install.ps1
#>

$root = $PSScriptRoot
$streamDeckExe = "C:\Program Files\Elgato\StreamDeck\StreamDeck.exe"
$pluginsDir = Join-Path $env:APPDATA "Elgato\StreamDeck\Plugins"
# The built plugin folders at the repo root, each installed under the same name, with a file only its build makes
# (the Node plugin's folder holds its manifest even before it's built).
$plugins = [ordered]@{
    "com.morgan-scruggs.audioswitcherplus-node.sdPlugin"      = "bin\plugin.js"
    "com.morgan-scruggs.audioswitcherplus-node-demo.sdPlugin" = "bin\plugin.js"
    "com.morganscruggs.audioswitcherplus.sdPlugin"            = "sdaudioswitchplus.exe"
}

if (-not (Test-Path $pluginsDir)) { throw "Stream Deck's Plugins folder isn't at $pluginsDir - is Stream Deck installed?" }

$built = @($plugins.Keys | Where-Object { Test-Path (Join-Path $root (Join-Path $_ $plugins[$_])) })
foreach ($name in $plugins.Keys) {
    if ($built -notcontains $name) { Write-Warning "$name hasn't been built - leaving it out (run build-all.ps1)." }
}
if ($built.Count -eq 0) { throw "Nothing has been built yet - run build-all.ps1 first." }

Write-Host "`n== Installing into Stream Deck" -ForegroundColor Cyan
Get-Process StreamDeck, sdaudioswitchplus -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
# Wait until it has really exited, since it only lets go of the Plugins folder then.
for ($i = 0; $i -lt 20 -and (Get-Process StreamDeck -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 500 }
try {
    foreach ($name in $built) {
        $installed = Join-Path $pluginsDir $name
        # A link back to the repo (a development setup) already sees every build.
        if ((Test-Path $installed) -and (Get-Item $installed -Force).LinkType) {
            Write-Host "  $name is a link to the build - nothing to copy"
            continue
        }
        # Files can stay locked for a moment after Stream Deck and its plugins exit, so retry briefly.
        for ($attempt = 1; ; $attempt++) {
            try {
                # Replaces what's in the folder rather than the folder itself: a program working in it (a terminal,
                # or a window one of the plugins opened) keeps the folder from being removed, but not its contents.
                New-Item -ItemType Directory -Force $installed | Out-Null
                Get-ChildItem -LiteralPath $installed -Force | Remove-Item -Recurse -Force -ErrorAction Stop
                Copy-Item -Path (Join-Path (Join-Path $root $name) "*") -Destination $installed -Recurse -Force -ErrorAction Stop
                # The exe's debug symbols are for debugging locally, not for Stream Deck (the package leaves
                # them out too, via .sdignore).
                Get-ChildItem -LiteralPath $installed -Filter *.pdb -Recurse | Remove-Item -Force
                break
            }
            catch {
                if ($attempt -ge 5) { throw "Couldn't install $name into Stream Deck: $($_.Exception.Message)" }
                Start-Sleep -Seconds 1
            }
        }
        Write-Host "  Installed $name"
    }
    Write-Host "`nInstalled $($built.Count) of $($plugins.Count) plugins." -ForegroundColor Green
}
finally {
    Write-Host "`n== Starting Stream Deck" -ForegroundColor Cyan
    if (Test-Path $streamDeckExe) { Start-Process $streamDeckExe }
    else { Write-Warning "Stream Deck isn't at $streamDeckExe - start it yourself." }
}
