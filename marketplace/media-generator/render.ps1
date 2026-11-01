# Renders gallery.html with headless Edge, once per listing, into that listing's own folder next to this one: the
# full version into ..\full\, and the demo version (gallery.html?demo) into ..\demo\. Each slide id maps to section
# #s<id>: #thumbnail is the listing card, written as thumbnail.png; #1..#4 are the gallery, written as
# gallery-<id>.png (all 1920x960, Elgato Marketplace thumbnail/gallery size); #icon is the 288x288 Marketplace app
# icon, written as icon.png. #2 and #4 are also written as videos, gallery-<id>.mp4, by animate.ps1.
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$html = (Resolve-Path "$PSScriptRoot\gallery.html").Path
$uri = ([System.Uri]$html).AbsoluteUri
# A profile of its own, so headless Edge never hands the job off to an Edge window that's already open.
$profileDir = Join-Path $env:TEMP "audio-switcher-gallery-edge"

function Render($url, $size, $out) {
    & $edge --headless=new --disable-gpu --hide-scrollbars --allow-file-access-from-files `
        --force-device-scale-factor=1 "--window-size=$size" --virtual-time-budget=3000 `
        "--user-data-dir=$profileDir" "--screenshot=$out" $url | Out-Null
    Write-Output "Wrote $out"
}

foreach ($edition in @("full", "demo")) {
    $dir = Join-Path (Split-Path $PSScriptRoot -Parent) $edition
    New-Item -ItemType Directory -Force $dir | Out-Null
    $query = if ($edition -eq "demo") { "?demo" } else { "" }

    # Clear out the old gallery first, so a slide that's been dropped or renumbered doesn't leave its image behind.
    Remove-Item (Join-Path $dir "gallery-*.png") -ErrorAction SilentlyContinue

    Render "$uri$query#thumbnail" "1920,960" (Join-Path $dir "thumbnail.png")
    foreach ($n in @("1", "2", "3", "4")) {
        Render "$uri$query#$n" "1920,960" (Join-Path $dir ("gallery-{0}.png" -f $n))
    }
    Render "$uri$query#icon" "288,288" (Join-Path $dir "icon.png")
}

# Then the animated slides, as videos (needs ffmpeg - see animate.ps1).
& (Join-Path $PSScriptRoot "animate.ps1")
