## Description

StreamDeck-AudioSwitcherPlus is an Elgato Stream Deck plugin for setting the default Windows audio device. **Windows only** - macOS is not supported.

> **This is a fork** of [Fred Emmott](https://github.com/fredemmott)'s original [StreamDeck-AudioOutputSwitcher](https://github.com/fredemmott/StreamDeck-AudioOutputSwitcher), extended with additional features (hiding disabled/unplugged devices, hiding device-type suffixes, an "All" button role, stripped Windows device-name prefixes, per-button custom icons with color selection, and keys that open Windows' sound settings). All credit for the original plugin, its design, and the underlying audio-switching approach goes to Fred Emmott — please check out [his other Stream Deck plugins](https://github.com/fredemmott) as well.

## Two implementations, one plugin

This repo contains two separate, independently-installable builds of the same plugin concept - same feature set (device direction, default/communication/"all" role, fuzzy device matching, custom icons/colors, sound settings keys), different underlying tech:

| | [`audio-switcher-exe/`](audio-switcher-exe/) | [`audio-switcher-node/`](audio-switcher-node/) |
|---|---|---|
| Runtime | Native C++, compiled to its own `sdaudioswitchplus.exe` | Node.js, running inside Stream Deck's own bundled Node runtime |
| Device switching | Direct in-process COM calls | The same COM calls, via inline C# in a long-running `powershell.exe` |
| Responsiveness | Fast - real-time, in-process | Near-instant once running; the first request after it starts waits for PowerShell to start |
| Windows Smart App Control | **Can be blocked** - it's a freshly-compiled, unsigned, no-reputation executable | Not affected - never launches its own executable, so there's nothing for Smart App Control to flag |
| Status | Original, most mature | Newer, built specifically to sidestep the Smart App Control issue |

Both install and run completely independently (different plugin UUIDs, different install folders), so you can have either or both active at once. If Smart App Control isn't a problem for you, the exe version is the leaner choice (no PowerShell process alongside it); otherwise the Node version avoids being blocked at the cost of a short startup delay. See each folder's own README for setup, features, and its own troubleshooting guide.

Shared assets (the button icons, the property inspector, and the `VERSION` file both plugins take their version from) live in [`shared/`](shared/) and are pulled in by both projects' build steps rather than duplicated.

## Demo version

The Node version also builds as a free demo - only the Node version, since it's the one published on the Elgato Marketplace (the exe can't be signed). The demo is a separate plugin with its own UUID (`com.morgan-scruggs.audioswitcherplus-node-demo`), so it installs alongside the full version. It has every feature of the full version, but each key only switches devices **10 times**:

- Only a press that actually changes the default device counts - one that changes nothing (the device is already set, or unplugged) doesn't. Once a key has none left, it shows the alert instead of switching.
- The count is kept in each key's own settings (`demoSwitchesUsed`, see `useSwitch()` in `audio-switcher-node/src/edition.ts`), so a new key starts at 10 - deliberately: making new keys is allowed, just tedious enough to make buying worthwhile. A copied key keeps its count.
- Every demo key shows how many it has left, as a red badge in its bottom-right corner, redrawn after each switch; the property inspector's demo note shows the same for the key being edited.
The limit is meant to make paying easier than not, not to be tamper-proof: anyone can build the full version from this repo.

`npm run build:demo` builds it (see [the Node README](audio-switcher-node/README.md#building)). CI packages and releases it with the full versions.

## Building

Each build documents its own process - see the "Building"/"Building From Source" section of [the exe README](audio-switcher-exe/README.md#building-from-source) or [the node README](audio-switcher-node/README.md#building). Both build steps install straight into `%APPDATA%\Elgato\StreamDeck\Plugins\`, so **fully quit Stream Deck before building/installing**, then relaunch it afterward to pick up the change.

To do all of it in one go, use the two scripts at the repo root - one builds, the other installs:

```powershell
powershell -ExecutionPolicy Bypass -File build-all.ps1
powershell -ExecutionPolicy Bypass -File install.ps1
```

[`build-all.ps1`](build-all.ps1) builds the Node plugin, the Node demo and the exe and packages all three into [`marketplace/`](marketplace/) (Node and exe into `full/`, the demo into `demo/`; add `-SkipPackage` to skip this). It never touches Stream Deck, which keeps running throughout. [`install.ps1`](install.ps1) then quits Stream Deck just long enough to copy whatever's been built into its Plugins folder, and starts it again - even if the copy fails. So build as often as you like, and install when you want to try the result. They need the same tools as the individual builds: Node.js, CMake and Visual Studio 2022's C++ workload.

## Releasing

CI builds, tests and packages both plugins on every push. To release, bump [`shared/VERSION`](shared/VERSION), commit, and push a matching tag (`0.2.0` or `v0.2.0`; a `-suffix` such as `0.2.0-beta1` marks a prerelease). That drafts a GitHub release with both `.streamDeckPlugin` files and the exe's debug symbols attached; the release job fails if the tag doesn't match `shared/VERSION`.

## Notes

This uses undocumented and unsupported Windows APIs (the same ones, either way). These have apparently worked since Windows 7, but they might stop working at any time or have unexpected side effects.

This fork does not support macOS - the upstream project did, but maintaining and testing a Mac build isn't something this fork can commit to. If you're on a Mac, use [the original StreamDeck-AudioOutputSwitcher](https://github.com/fredemmott/StreamDeck-AudioOutputSwitcher) instead.

## Getting Help

Check the relevant troubleshooting guide first ([exe](audio-switcher-exe/TROUBLESHOOTING.md) / [node](audio-switcher-node/TROUBLESHOOTING.md)). If that doesn't help, you can reach me through GitHub by [opening an issue](https://github.com/morganscruggs/StreamDeck-AudioSwitcher/issues) - but I make this mainly for my own use, and share it in the hope that others find it useful, so I may be slow to respond.

## Thanks

- Thanks to [Fred Emmott](https://github.com/fredemmott) for creating the original [StreamDeck-AudioOutputSwitcher](https://github.com/fredemmott/StreamDeck-AudioOutputSwitcher) that this project is forked from.
- Thanks to "EreTIk" for finding/documenting the COM interface both implementations here rely on.
- Thanks to "LordValgor" for the idea of making this plugin.

## License

This project is [MIT-licensed](LICENSE)
