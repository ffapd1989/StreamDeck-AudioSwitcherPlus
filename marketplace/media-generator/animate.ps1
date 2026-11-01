# Renders gallery.html's animated slides, #2 and #4, as looping MP4s, once per listing as render.ps1 does its images:
# gallery-<n>.mp4 beside gallery-<n>.png in ..\full\ and ..\demo\. Each frame of a slide's animation (see ANIMATIONS
# in gallery.html) is screenshotted by headless Edge at 1920x1080, the Marketplace's video size, and ffmpeg holds each
# one as long as the page's timeline says and cross-fades it into the next - the last back into the first, so the
# video loops. render.ps1 runs this after its images. Needs ffmpeg: winget install Gyan.FFmpeg
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$html = (Resolve-Path "$PSScriptRoot\gallery.html").Path
$uri = ([System.Uri]$html).AbsoluteUri
# The same Edge profile as render.ps1's, and a scratch folder for the frames.
$profileDir = Join-Path $env:TEMP "audio-switcher-gallery-edge"
$framesDir = Join-Path $env:TEMP "audio-switcher-gallery-frames"
$fps = 30

# winget puts ffmpeg on PATH, but only for shells started after it was installed.
$ffmpeg = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source
if (-not $ffmpeg) {
    $ffmpeg = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Gyan.FFmpeg*" -Recurse -Filter ffmpeg.exe -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $ffmpeg) { throw "ffmpeg not found - install it with: winget install Gyan.FFmpeg" }

# Seconds as ffmpeg takes them, whatever the system's decimal separator.
function Seconds([double]$value) { $value.ToString("0.###", [cultureinfo]::InvariantCulture) }

foreach ($edition in @("full", "demo")) {
    $dir = Join-Path (Split-Path $PSScriptRoot -Parent) $edition
    New-Item -ItemType Directory -Force $dir | Out-Null
    $query = if ($edition -eq "demo") { "?demo&video" } else { "?video" }
    # Clear out the old videos first, so a slide that's no longer animated doesn't leave its video behind.
    Remove-Item (Join-Path $dir "gallery-*.mp4") -ErrorAction SilentlyContinue

    foreach ($n in @("2", "4")) {
        # The frames' timings ([{ms, fade}, ...]), which the page puts in its title.
        $dom = & $edge --headless=new --disable-gpu --allow-file-access-from-files --virtual-time-budget=1000 `
            "--user-data-dir=$profileDir" --dump-dom "$uri$query&timeline#$n" 2>$null | Out-String
        if ($dom -notmatch '<title>(\[.*?\])</title>') { throw "gallery.html gave no timeline for slide #$n." }
        # Windows PowerShell's ConvertFrom-Json passes an array on as one object, so unroll it.
        $frames = @($Matches[1] | ConvertFrom-Json | ForEach-Object { $_ })
        $count = $frames.Count

        $out = Join-Path $framesDir "$edition-$n"
        Remove-Item $out -Recurse -Force -ErrorAction SilentlyContinue
        New-Item -ItemType Directory -Force $out | Out-Null
        for ($i = 0; $i -lt $count; $i++) {
            & $edge --headless=new --disable-gpu --hide-scrollbars --allow-file-access-from-files `
                --force-device-scale-factor=1 "--window-size=1920,1080" --virtual-time-budget=3000 `
                "--user-data-dir=$profileDir" "--screenshot=$(Join-Path $out "$i.png")" "$uri$query&frame=$i#$n" 2>$null | Out-Null
        }

        # Each frame is an input held for its `ms` plus the fades either side of it, which it shares with the frames
        # before and after. The first frame comes again at the end, to fade back into; the video stops as that fade
        # ends, at the very picture it starts with.
        $inputs = @()
        $filters = @()
        $length = 0.0
        for ($i = 0; $i -le $count; $i++) {
            $fadeIn = if ($i -gt 0) { $frames[$i - 1].fade / 1000 } else { 0 }
            $hold = if ($i -lt $count) { $frames[$i].ms / 1000 } else { 0 }
            # The repeated first frame only has to outlast its fade.
            $fadeOut = if ($i -lt $count) { $frames[$i].fade / 1000 } else { 0.1 }
            $duration = $fadeIn + $hold + $fadeOut
            $inputs += "-loop", "1", "-framerate", "$fps", "-t", (Seconds $duration), "-i", (Join-Path $out "$($i % $count).png")
            $filters += "[$($i):v]format=yuv420p,settb=AVTB[v$i]"
            if ($i -eq 0) {
                $length = $duration
                continue
            }
            $from = if ($i -eq 1) { "v0" } else { "x$($i - 1)" }
            $filters += "[$from][v$i]xfade=transition=fade:duration=$(Seconds $fadeIn):offset=$(Seconds ($length - $fadeIn))[x$i]"
            $length += $duration - $fadeIn
        }
        $loop = ($frames | ForEach-Object { $_.ms + $_.fade } | Measure-Object -Sum).Sum / 1000

        $video = Join-Path $dir "gallery-$n.mp4"
        & $ffmpeg -hide_banner -loglevel error -y @inputs -filter_complex ($filters -join ";") -map "[x$count]" `
            -t (Seconds $loop) -r $fps -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -movflags +faststart -an $video
        if ($LASTEXITCODE -ne 0) { throw "ffmpeg failed on slide #$n ($edition)." }
        Write-Output "Wrote $video"
    }
}
