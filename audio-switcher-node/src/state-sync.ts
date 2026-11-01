import type { KeyAction } from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";
import { getVolatileDeviceId } from "./device-match";
import { audioDeviceService } from "./audio-device-service";
import { useSwitch } from "./edition";
import type { AudioDeviceDirection, AudioDeviceRole, AudioSnapshot, ButtonSettings, DirectionSnapshot } from "./types";

export type ActionKind = "set" | "toggle";

type DeviceSlot = "primary" | "secondary" | "primaryInput" | "secondaryInput";

const DEVICE_SLOTS = ["primary", "secondary", "primaryInput", "secondaryInput"] as const;

// What "both" switches, output then input: Set's own two devices, or one of Toggle's two pairs.
const SET_BOTH_SLOTS = ["primary", "secondary"] as const;
const TOGGLE_PAIR_SLOTS = { primary: ["primary", "primaryInput"], secondary: ["secondary", "secondaryInput"] } as const;

/**
 * The direction a configured device is picked from. In "both", Set has its output as primary and its input as
 * secondary, while Toggle's primary and secondary are both outputs, each with its own input (see ButtonDirection).
 */
function slotDirection(settings: ButtonSettings, kind: ActionKind, slot: DeviceSlot): AudioDeviceDirection {
	if (slot === "primaryInput" || slot === "secondaryInput") return "input";
	if (settings.direction !== "both") return settings.direction;
	return kind === "set" && slot === "secondary" ? "input" : "output";
}

function slotSnapshot(snapshot: AudioSnapshot | undefined, settings: ButtonSettings, kind: ActionKind, slot: DeviceSlot): DirectionSnapshot | undefined {
	return snapshot?.[slotDirection(settings, kind, slot)];
}

function resolveDeviceId(settings: ButtonSettings, kind: ActionKind, slot: DeviceSlot, snapshot: AudioSnapshot | undefined): string {
	return getVolatileDeviceId(settings[slot], settings.matchStrategy, slotSnapshot(snapshot, settings, kind, slot));
}

function defaultIdForRole(dirSnap: DirectionSnapshot | undefined, role: ButtonSettings["role"]): string {
	return (role === "communication" ? dirSnap?.communicationsDeviceId : dirSnap?.defaultDeviceId) ?? "";
}

/** Whether `deviceId` is already the device for every role the button sets. */
function isActiveForRole(dirSnap: DirectionSnapshot | undefined, role: ButtonSettings["role"], deviceId: string): boolean {
	if (role === "all") return deviceId === (dirSnap?.defaultDeviceId ?? "") && deviceId === (dirSnap?.communicationsDeviceId ?? "");
	return deviceId === defaultIdForRole(dirSnap, role);
}

function rolesFor(settings: ButtonSettings): AudioDeviceRole[] {
	return settings.role === "all" ? ["default", "communication"] : [settings.role];
}

type BothDevice = { deviceId: string; dirSnap: DirectionSnapshot | undefined };

/** The configured devices among "both"'s `slots` (output, then input), each with its own direction's snapshot. */
function bothDevices(settings: ButtonSettings, kind: ActionKind, slots: readonly DeviceSlot[], snapshot: AudioSnapshot | undefined): BothDevice[] {
	return slots
		.map((slot) => ({ deviceId: resolveDeviceId(settings, kind, slot, snapshot), dirSnap: slotSnapshot(snapshot, settings, kind, slot) }))
		.filter(({ deviceId }) => deviceId);
}

/** Whether every one of `devices` is active; a slot left unset doesn't count against it, but none set at all isn't. */
function allActive(devices: BothDevice[], role: ButtonSettings["role"]): boolean {
	return devices.length > 0 && devices.every(({ deviceId, dirSnap }) => isActiveForRole(dirSnap, role, deviceId));
}

/**
 * If a configured device is missing its display metadata (e.g. it was only ever saved as a bare ID),
 * backfill it from the live snapshot and persist - ported from FillButtonDeviceInfo/FillAudioDeviceInfo
 * in AudioSwitcherStreamDeckPlugin.cpp. Needed for fuzzy matching, which compares interfaceName/
 * endpointName, not just id.
 */
export async function backfillDeviceInfo(
	action: KeyAction<ButtonSettings>,
	kind: ActionKind,
	settings: ButtonSettings,
	snapshot: AudioSnapshot | undefined
): Promise<void> {
	let changed = false;
	for (const key of DEVICE_SLOTS) {
		const dirSnap = slotSnapshot(snapshot, settings, kind, key);
		const device = settings[key];
		if (dirSnap && device?.id && !device.displayName) {
			const found = dirSnap.devices[device.id];
			if (found) {
				settings[key] = found;
				changed = true;
			}
		}
	}

	if (changed) {
		await action.setSettings(settings).catch((error) => streamDeck.logger.error("Failed to backfill device info", error));
	}
}

// Last resolved active/primary/secondary IDs per action, so polling (which re-runs updateState every
// tick, unlike the C++ plugin's change-driven callback) doesn't re-flash the alert every few seconds.
const lastResolved = new Map<string, string>();

/** Drops the per-action state kept by {@link updateState}; call when the action disappears. */
export function forgetState(actionId: string): void {
	lastResolved.delete(actionId);
	heldUpdates.delete(actionId);
}

// While a key press's switch is under way, every button's state updates are held, and once it has finished
// only the latest one per button is applied - so a change notification landing mid-switch can't show a
// button an in-between state.
let switchesInProgress = 0;
const heldUpdates = new Map<string, () => void>();

function endSwitch(): void {
	switchesInProgress = Math.max(0, switchesInProgress - 1);
	if (switchesInProgress !== 0) return;
	const updates = Array.from(heldUpdates.values());
	heldUpdates.clear();
	for (const update of updates) update();
}

/**
 * Mirrors UpdateState() in AudioSwitcherStreamDeckPlugin.cpp. With `fromPoll`, the "neither device is
 * active" alert is only shown when something actually changed since the last update.
 */
export function updateState(
	action: KeyAction<ButtonSettings>,
	kind: ActionKind,
	settings: ButtonSettings,
	snapshot: AudioSnapshot | undefined,
	fromPoll = false
): void {
	if (switchesInProgress > 0) {
		heldUpdates.set(action.id, () => updateState(action, kind, settings, snapshot, fromPoll));
		return;
	}

	if (settings.direction === "both" && kind === "set") {
		// On only while its output and its input are both active; one left unset doesn't count against it.
		const on = allActive(bothDevices(settings, kind, SET_BOTH_SLOTS, snapshot), settings.role);
		action.setState(on ? 0 : 1).catch((error) => streamDeck.logger.error("Failed to set state", error));
		return;
	}

	if (settings.direction === "both") {
		updatePairsState(action, settings, snapshot, fromPoll);
		return;
	}

	const dirSnap = slotSnapshot(snapshot, settings, kind, "primary");
	const primaryId = resolveDeviceId(settings, kind, "primary", snapshot);
	const secondaryId = resolveDeviceId(settings, kind, "secondary", snapshot);

	let activeDevice: string;
	if (settings.role === "all") {
		activeDevice = dirSnap?.defaultDeviceId ?? "";
		// This looks backwards (falling through to the communications device when the console default
		// already matches primary/secondary) but mirrors UpdateState()'s exact condition verbatim.
		if (!activeDevice || activeDevice === secondaryId || activeDevice === primaryId) {
			activeDevice = dirSnap?.communicationsDeviceId ?? "";
		}
	} else {
		activeDevice = defaultIdForRole(dirSnap, settings.role);
	}

	const unchanged = resolvedUnchanged(action.id, `${activeDevice}|${primaryId}|${secondaryId}`);

	if (kind === "set") {
		action.setState(activeDevice === primaryId ? 0 : 1).catch((error) => streamDeck.logger.error("Failed to set state", error));
		return;
	}

	if (activeDevice === primaryId) {
		action.setState(0).catch((error) => streamDeck.logger.error("Failed to set state", error));
		return;
	}
	if (activeDevice === secondaryId) {
		action.setState(1).catch((error) => streamDeck.logger.error("Failed to set state", error));
		return;
	}
	if (fromPoll && unchanged) return;
	action.showAlert().catch((error) => streamDeck.logger.error("Failed to show alert", error));
}

/** Records what an action's state was last resolved from; true if it's the same as the time before. */
function resolvedUnchanged(actionId: string, resolved: string): boolean {
	const unchanged = lastResolved.get(actionId) === resolved;
	lastResolved.set(actionId, resolved);
	return unchanged;
}

/**
 * Toggle's "both": shows whichever of its two pairs is active - every device the pair has set is - and, as for a
 * single device, alerts when neither is.
 */
function updatePairsState(action: KeyAction<ButtonSettings>, settings: ButtonSettings, snapshot: AudioSnapshot | undefined, fromPoll: boolean): void {
	const primary = bothDevices(settings, "toggle", TOGGLE_PAIR_SLOTS.primary, snapshot);
	const secondary = bothDevices(settings, "toggle", TOGGLE_PAIR_SLOTS.secondary, snapshot);
	const roleIds = (dirSnap: DirectionSnapshot | undefined) => `${dirSnap?.defaultDeviceId}|${dirSnap?.communicationsDeviceId}`;
	const ids = (devices: BothDevice[]) => devices.map(({ deviceId }) => deviceId).join(",");
	const unchanged = resolvedUnchanged(action.id, `${roleIds(snapshot?.output)}|${roleIds(snapshot?.input)}|${ids(primary)}|${ids(secondary)}`);

	if (allActive(primary, settings.role)) {
		action.setState(0).catch((error) => streamDeck.logger.error("Failed to set state", error));
		return;
	}
	if (allActive(secondary, settings.role)) {
		action.setState(1).catch((error) => streamDeck.logger.error("Failed to set state", error));
		return;
	}
	if (fromPoll && unchanged) return;
	action.showAlert().catch((error) => streamDeck.logger.error("Failed to show alert", error));
}

/**
 * Handles a key press for either action, holding every button's state updates until the switch has
 * finished (see {@link heldUpdates}). Stream Deck flips a two-state key's image itself on press, so the
 * pressed key is always re-resolved afterwards, even if the press changed nothing (e.g. an unplugged
 * device), rather than being left on the image Stream Deck flipped it to.
 */
export async function performKeyPress(action: KeyAction<ButtonSettings>, kind: ActionKind, settings: ButtonSettings, state: number | undefined): Promise<void> {
	switchesInProgress++;
	heldUpdates.set(action.id, () => updateState(action, kind, settings, audioDeviceService.getSnapshot()));
	try {
		await switchDevice(action, kind, settings, state);
	} finally {
		endSwitch();
	}
}

/**
 * Ported from the shared tail of KeyUpForAction() in AudioSwitcherStreamDeckPlugin.cpp. `state` is the
 * action's state *before* this press (as reported by Stream Deck) - for Toggle, state 0 means "currently
 * showing primary, so target the secondary device" and vice versa; this looks inverted but matches the
 * original comment/behavior exactly. For Set, always targets the primary (its "secondary" concept doesn't
 * apply).
 */
async function switchDevice(action: KeyAction<ButtonSettings>, kind: ActionKind, settings: ButtonSettings, state: number | undefined): Promise<void> {
	if (settings.direction === "both") {
		// Set's own output and input, or the Toggle pair it isn't showing (picked as for a single device, below).
		const slots = kind === "set" ? SET_BOTH_SLOTS : TOGGLE_PAIR_SLOTS[state !== 0 ? "primary" : "secondary"];
		await switchBothDevices(action, kind, settings, slots, state);
		return;
	}

	const snapshot = audioDeviceService.getSnapshot();
	const dirSnap = slotSnapshot(snapshot, settings, kind, "primary");

	const deviceId = resolveDeviceId(settings, kind, state !== 0 || kind === "set" ? "primary" : "secondary", snapshot);
	if (!deviceId) {
		await action.showAlert().catch(() => undefined);
		return;
	}

	const deviceState = dirSnap?.devices[deviceId]?.state;
	if (deviceState !== "connected") {
		if (kind === "set") await action.setState(1).catch(() => undefined);
		await action.showAlert().catch(() => undefined);
		return;
	}

	if (kind === "set" && isActiveForRole(dirSnap, settings.role, deviceId)) {
		if (state !== undefined) await action.setState(state).catch(() => undefined);
		return;
	}

	// The demo's per-key allowance: only a press that's about to change the device counts, and once the key has
	// none left it doesn't switch (performKeyPress re-resolves the key's state).
	if (!useSwitch(action, settings)) {
		await action.showAlert().catch(() => undefined);
		return;
	}

	await audioDeviceService.setDefaultDevices(rolesFor(settings), [deviceId]);
}

/**
 * "both": sets an output and an input device together - Set's own two, or the Toggle pair it's flipping to. One
 * that's unplugged is skipped with an alert rather than holding back the other, and the demo counts the press as
 * one switch. A Toggle key's state is left to performKeyPress to re-resolve.
 */
async function switchBothDevices(
	action: KeyAction<ButtonSettings>,
	kind: ActionKind,
	settings: ButtonSettings,
	slots: readonly DeviceSlot[],
	state: number | undefined
): Promise<void> {
	const devices = bothDevices(settings, kind, slots, audioDeviceService.getSnapshot());
	if (devices.length === 0) {
		await action.showAlert().catch(() => undefined);
		return;
	}

	const connected = devices.filter(({ deviceId, dirSnap }) => dirSnap?.devices[deviceId]?.state === "connected");
	const missing = connected.length < devices.length;
	const toSet = connected.filter(({ deviceId, dirSnap }) => !isActiveForRole(dirSnap, settings.role, deviceId)).map(({ deviceId }) => deviceId);

	if (toSet.length === 0) {
		if (missing) {
			if (kind === "set") await action.setState(1).catch(() => undefined);
			await action.showAlert().catch(() => undefined);
		} else if (kind === "set" && state !== undefined) {
			await action.setState(state).catch(() => undefined);
		}
		return;
	}

	if (!useSwitch(action, settings)) {
		await action.showAlert().catch(() => undefined);
		return;
	}

	await audioDeviceService.setDefaultDevices(rolesFor(settings), toSet);
	if (missing) await action.showAlert().catch(() => undefined);
}
