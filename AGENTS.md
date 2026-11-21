# Agent notes

## Two versions, developed in parallel

This repo holds two independent implementations of the same plugin, kept at feature parity (see [`README.md`](README.md), "Two implementations, one plugin"):

- **Native/exe (C++):** [`audio-switcher-exe/`](audio-switcher-exe/) - sources in `Sources/`, manifest template in `sdPlugin/`.
- **Node (TypeScript):** [`audio-switcher-node/`](audio-switcher-node/) - sources in `src/`; its manifest lives in [`com.morgan-scruggs.audioswitcherplus-node.sdPlugin/`](com.morgan-scruggs.audioswitcherplus-node.sdPlugin/).

Shared between both are in [`shared/`](shared/): the button icons, the property inspector (one copy - each build copies it in, and it tells the plugins/actions apart at runtime, so a PI change is automatically a change to both), and the `VERSION` file both builds read their version from (bump it there, not in either manifest). The untracked `com.morganscruggs.audioswitcherplus.sdPlugin/` at the repo root is exe build output - don't edit it; likewise the node plugin folder's `bin/`, `AudioDevicesIcons/`, `SettingsIcons/` and `propertyinspector/`, and the node demo's `com.morgan-scruggs.audioswitcherplus-node-demo.sdPlugin/` folder.

**Unless the user says otherwise, apply every change to both versions** - features, bug fixes, and UI/property-inspector changes alike - adapting to each one's language and structure rather than copying code verbatim. If a change genuinely only applies to one (e.g. a PowerShell-bridge issue in the node version, or a CMake/build issue in the exe version), say so rather than silently skipping the other. When reporting back, state which version(s) were changed.

## The demo is Node-only

**The demo edition exists only for the Node version** - it's the one published on the Elgato Marketplace, since the exe can't be signed. Don't add a demo build to the exe, and don't treat demo work as needing exe parity: demo limits, demo-only property-inspector UI and the demo's Marketplace listing apply to the Node version alone (see "Demo version" in the README). The demo's limits live in `audio-switcher-node/src/edition.ts` and in the shared property inspector, which recognizes the demo by its `-node-demo` UUID - keep those two in step. The exe never runs the PI's demo code, so it needs no change for it. Everything else still follows the both-versions rule above.

## Building

Before building, rebuilding, or installing either plugin in this repo, read the build steps in the README rather than guessing:

- Native/exe plugin: [`audio-switcher-exe/README.md`](audio-switcher-exe/README.md) ("Building From Source")
- Node plugin: [`audio-switcher-node/README.md`](audio-switcher-node/README.md) ("Building")
- Overview of both, and the shared gotcha below: [`README.md`](README.md) ("Building")

The one thing both share and easy to miss: **fully quit Stream Deck before building/installing.** Its main process (`StreamDeck.exe`), not just the plugin's own process, holds file handles inside `%APPDATA%\Elgato\StreamDeck\Plugins\`, and the install step's auto-sync to that folder fails with a permission error if Stream Deck is running - the compile itself will still report success, so this is easy to misdiagnose as "installed but not picked up." Relaunch Stream Deck after the build completes.

[`build-all.ps1`](build-all.ps1) at the repo root does a whole local build unattended - builds the Node plugin, the Node demo and the exe and packages them (below) while Stream Deck keeps running (each build's own copy into the Plugins folder is turned off with `SYNC_TO_STREAMDECK=0`); it never touches Stream Deck. [`install.ps1`](install.ps1) installs what's been built: it quits Stream Deck only to copy the plugins in, and starts it again. Prefer them to running the steps by hand; they're also what the user runs without an agent, so keep them in step with the READMEs' build steps.

**Build after every change, but install only when the user asks.** Run `build-all.ps1` once a change is made, so it's compiled, checked and packaged - but never `install.ps1`, or anything else that closes Stream Deck or writes into its Plugins folder, unless the user says to install: installing restarts Stream Deck under them.

**After building, refresh the packages in [`marketplace/`](marketplace/)** (`build-all.ps1` does this) by running `marketplace/package.ps1`: it packs the Node plugin and the exe into `marketplace/full/` and the Node demo into `marketplace/demo/` (the exe goes into `full/` too, even though only the Node one is published). Build all three first - the script only packs what's built. It also restores `manifest.json`, which `streamdeck pack` rewrites. The listings' images are rendered separately, by `marketplace/media-generator/render.ps1`; re-run it when the property inspector, icons or the demo's limits change, since the images show them. It also renders gallery slides 2 and 4 as looping MP4s (via `animate.ps1`, which needs ffmpeg - `winget install Gyan.FFmpeg`).
