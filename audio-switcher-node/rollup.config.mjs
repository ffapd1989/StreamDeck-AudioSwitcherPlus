import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const isWatching = !!process.env.ROLLUP_WATCH;
// The full plugin's folder holds its hand-edited manifest.json; the demo's (`npm run build:demo`) is
// generated whole from it, so the demo is the same code under its own UUID - src/edition.ts and the
// property inspector recognize it by the "-demo" suffix. The demo is Node-only (see AGENTS.md).
const fullPluginUUID = "com.morgan-scruggs.audioswitcherplus-node";
const demoPluginUUID = `${fullPluginUUID}-demo`;

/**
 * @param {Record<string, unknown>} commandLineArgs
 * @returns {import('rollup').RollupOptions}
 */
export default function config(commandLineArgs) {
	const isDemo = !!commandLineArgs.configDemo;
	// Bare folder name (used for the AppData destination path) vs. where the build actually writes it
	// (the repo's top-level directory, alongside audio-switcher-exe/'s own build output and shared/) -
	// keep these separate so path.join(...Plugins, sdPluginName) doesn't get corrupted by a ".." segment.
	const sdPluginName = `${isDemo ? demoPluginUUID : fullPluginUUID}.sdPlugin`;
	const sdPlugin = `../${sdPluginName}`;
	const fullSdPlugin = `../${fullPluginUUID}.sdPlugin`;

	return {
		input: "src/plugin.ts",
		output: {
			file: `${sdPlugin}/bin/plugin.js`,
			// The plugin's UUID for src/edition.ts, written into the bundle rather than read from manifest.json
			// at runtime, which Marketplace packages protect (DRM).
			intro: `const __PLUGIN_UUID__ = ${JSON.stringify(isDemo ? demoPluginUUID : fullPluginUUID)};`,
			sourcemap: isWatching,
			sourcemapPathTransform: (relativeSourcePath, sourcemapPath) => {
				return url.pathToFileURL(path.resolve(path.dirname(sourcemapPath), relativeSourcePath)).href;
			}
		},
		plugins: [
			{
				name: "watch-externals",
				buildStart: function () {
					this.addWatchFile(`${fullSdPlugin}/manifest.json`);
				},
			},
			{
				// The plugin version lives once in ../shared/VERSION (also read by the C++ plugin's CMake), with
				// the CI run number as the fourth component, as there. manifest.json is hand-edited source, so
				// it's only rewritten when the version actually differs, keeping its existing line endings.
				name: "stamp-manifest-version",
				buildStart() {
					const versionFile = path.join("..", "shared", "VERSION");
					this.addWatchFile(versionFile);
					const version = `${fs.readFileSync(versionFile, "utf8").trim()}.${process.env.GITHUB_RUN_NUMBER ?? 0}`;

					const manifestPath = path.join(fullSdPlugin, "manifest.json");
					const text = fs.readFileSync(manifestPath, "utf8");
					const manifest = JSON.parse(text);
					const eol = text.includes("\r\n") ? "\r\n" : "\n";

					if (isDemo) {
						// Generated, so always rewritten: the full manifest under the demo's UUID and name.
						manifest.Version = version;
						manifest.UUID = demoPluginUUID;
						manifest.Name = "Audio Switcher Plus Demo";
						manifest.Category = manifest.Name;
						manifest.Description = "Try out Audio Switcher Plus: toggle or set the active audio devices, with 10 switches per key. Based on Fred Emmott's Audio Switcher (github.com/fredemmott).";
						for (const action of manifest.Actions) {
							action.UUID = action.UUID.replace(fullPluginUUID, demoPluginUUID);
						}
						fs.mkdirSync(sdPlugin, { recursive: true });
						fs.writeFileSync(path.join(sdPlugin, "manifest.json"), JSON.stringify(manifest, null, "\t").replace(/\n/g, eol) + eol);
						fs.copyFileSync(path.join(fullSdPlugin, "LICENSE"), path.join(sdPlugin, "LICENSE"));
						return;
					}

					if (manifest.Version === version) return;

					manifest.Version = version;
					fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, "\t").replace(/\n/g, eol) + eol);
					console.log(`Stamped manifest.json with version ${version}`);
				}
			},
			{
				// The icon PNGs and the property inspector live once in ../shared (also used by the C++
				// plugin's own build), rather than being duplicated into this project - Stream Deck plugins
				// must be self-contained at runtime though, so each build copies them into this plugin's
				// own folder.
				name: "copy-shared-assets",
				buildStart() {
					for (const folder of ["AudioDevicesIcons", "SettingsIcons", "propertyinspector"]) {
						const src = path.join("..", "shared", folder);
						const dest = path.join(sdPlugin, folder);
						fs.mkdirSync(dest, { recursive: true });
						for (const file of fs.readdirSync(src)) {
							this.addWatchFile(path.join(src, file));
							fs.copyFileSync(path.join(src, file), path.join(dest, file));
						}
					}
				}
			},
			{
				// Stream Deck runs its own copy of the plugin from its Plugins folder, not from this
				// project. If that folder is a symlink back to this project, Stream Deck already sees
				// every build - skip copying (copying a folder onto itself would error). Otherwise,
				// mirror the freshly built plugin into it so a plain `npm run build` stays the only
				// step ever needed. Set SYNC_TO_STREAMDECK=0 to skip this (CI/packaging builds), matching
				// the C++ plugin's SYNC_TO_STREAMDECK CMake option.
				name: "sync-to-streamdeck",
				writeBundle() {
					if (process.env.SYNC_TO_STREAMDECK === "0") return;
					const appData = process.env.APPDATA;
					if (!appData) return;

					const installed = path.join(appData, "Elgato", "StreamDeck", "Plugins", sdPluginName);
					if (!fs.existsSync(path.dirname(installed))) return;

					try {
						if (fs.existsSync(installed) && fs.lstatSync(installed).isSymbolicLink()) return;
						fs.rmSync(installed, { recursive: true, force: true });
						fs.cpSync(sdPlugin, installed, { recursive: true });
						console.log(`Synced plugin to ${installed}`);
					} catch (error) {
						console.warn(`Could not sync plugin to Stream Deck's Plugins folder: ${error.message}`);
					}
				}
			},
			typescript({
				mapRoot: isWatching ? "./" : undefined
			}),
			nodeResolve({
				browser: false,
				exportConditions: ["node"],
				preferBuiltins: true
			}),
			commonjs(),
			!isWatching && terser(),
			{
				name: "emit-module-package-file",
				generateBundle() {
					this.emitFile({ fileName: "package.json", source: `{ "type": "module" }`, type: "asset" });
				}
			}
		]
	};
}
