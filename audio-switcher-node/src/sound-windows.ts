import streamDeck from "@elgato/streamdeck";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PLUGIN_ROOT } from "./edition";

/**
 * Windows' own sound settings - the classic Sound control panel (mmsys.cpl) and Sound in the Settings app - which
 * the Sound Control Panel and Sound Settings keys open.
 */

const WINDOWS_DIR = process.env.SystemRoot ?? "C:\\Windows";
const SYSTEM_DIR = path.join(WINDOWS_DIR, "System32");

// The keys show the Sound control panel's own icon, at the size the other icons look on a key.
const KEY_IMAGE_SIZE = 144;
const SOUND_ICON_SIZE = 96;

// Writes the Sound control panel's icon (resource 100 in mmsys.cpl) as a base64 PNG. It's Microsoft's artwork, so
// it's read from Windows rather than shipped with the plugin; Node can't read icons itself, so PowerShell does.
const SOUND_ICON_SCRIPT = `
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace AudioSwitcherPlus -Name Icons -MemberDefinition '
[DllImport("shell32.dll", CharSet = CharSet.Unicode)]
public static extern int SHDefExtractIconW(string iconFile, int index, uint flags, out IntPtr large, IntPtr small, uint size);
[DllImport("user32.dll")]
public static extern bool DestroyIcon(IntPtr icon);'
$icon = [IntPtr]::Zero
$file = Join-Path ([Environment]::SystemDirectory) "mmsys.cpl"
if ([AudioSwitcherPlus.Icons]::SHDefExtractIconW($file, -100, 0, [ref]$icon, [IntPtr]::Zero, ${SOUND_ICON_SIZE}) -ne 0) { exit 1 }
$stream = New-Object System.IO.MemoryStream
[System.Drawing.Icon]::FromHandle($icon).ToBitmap().Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
[AudioSwitcherPlus.Icons]::DestroyIcon($icon) | Out-Null
[Convert]::ToBase64String($stream.ToArray())
`;

let soundIcon: Promise<string | undefined> | undefined;

/**
 * The Sound control panel's icon as a base64 PNG, read once - it doesn't change while the plugin runs; undefined
 * if Windows doesn't have it - the counterpart of SoundControlPanelIconBase64 in AudioSwitcherStreamDeckPlugin.cpp.
 */
function soundControlPanelIcon(): Promise<string | undefined> {
	soundIcon ??= new Promise((resolve) => {
		execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", SOUND_ICON_SCRIPT], { windowsHide: true }, (error, stdout) => {
			const png = stdout.trim();
			if (error || !png) {
				streamDeck.logger.error("Failed to read the Sound control panel's icon", error);
				resolve(undefined);
				return;
			}
			resolve(png);
		});
	});
	return soundIcon;
}

/**
 * A key image of the Sound control panel's icon (a base64 PNG) at (offset, offset), with the key-sized base64 PNG
 * `overlay` over it if given - as an SVG, which Stream Deck takes as it would a PNG. Matches SoundKeyImage in
 * AudioSwitcherStreamDeckPlugin.cpp.
 */
function keyImage(icon: string, offset: number, overlay?: string): string {
	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${KEY_IMAGE_SIZE}" height="${KEY_IMAGE_SIZE}" viewBox="0 0 ${KEY_IMAGE_SIZE} ${KEY_IMAGE_SIZE}">` +
		`<image x="${offset}" y="${offset}" width="${SOUND_ICON_SIZE}" height="${SOUND_ICON_SIZE}" xlink:href="data:image/png;base64,${icon}"/>` +
		(overlay ? `<image width="${KEY_IMAGE_SIZE}" height="${KEY_IMAGE_SIZE}" xlink:href="data:image/png;base64,${overlay}"/>` : "") +
		`</svg>`;
	return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

/**
 * The Sound Control Panel key's image, or the Sound Settings key's (`withGear`): the Sound control panel's icon,
 * with a gear for Settings; undefined without the icon - the counterpart of SoundKeyImageFor in
 * AudioSwitcherStreamDeckPlugin.cpp.
 */
export async function soundKeyImage(withGear: boolean): Promise<string | undefined> {
	const icon = await soundControlPanelIcon();
	if (!icon) return undefined;
	if (!withGear) return keyImage(icon, (KEY_IMAGE_SIZE - SOUND_ICON_SIZE) / 2);

	// The same speaker, moved up and left for the gear.
	let gear: string | undefined;
	try {
		gear = fs.readFileSync(path.join(PLUGIN_ROOT, "SettingsIcons", "sound-settings-badge.png")).toString("base64");
	} catch (error) {
		streamDeck.logger.error("Failed to read the Sound Settings key's gear", error);
	}
	return keyImage(icon, 14, gear);
}

/**
 * Starts `command` and leaves it running on its own, calling `onError` if it couldn't be started - the
 * counterpart of ShellOpen in AudioSwitcherStreamDeckPlugin.cpp.
 */
function open(command: string, args: string[], onError?: () => void): void {
	// Started in the system folder rather than the plugin's own: a window working in the plugin's folder keeps it
	// from being updated or removed while it's open.
	const child = spawn(command, args, { cwd: SYSTEM_DIR, detached: true, stdio: "ignore" });
	child.once("error", (error) => {
		streamDeck.logger.error(`Failed to start ${command}`, error);
		onError?.();
	});
	child.unref();
}

/** Opens the classic Sound control panel (mmsys.cpl). */
export function openSoundControlPanel(onError?: () => void): void {
	open(path.join(SYSTEM_DIR, "control.exe"), ["mmsys.cpl"], onError);
}

/** Opens Sound in the Windows Settings app. */
export function openSoundSettings(onError?: () => void): void {
	// Explorer hands the URI to whatever handles it - the Settings app.
	open(path.join(WINDOWS_DIR, "explorer.exe"), ["ms-settings:sound"], onError);
}
