import streamDeck, { action, KeyUpEvent, SingletonAction, WillAppearEvent } from "@elgato/streamdeck";
import { PLUGIN_UUID } from "../edition";
import { openSoundControlPanel, openSoundSettings, soundKeyImage } from "../sound-windows";

/**
 * Draws the key's image - the Sound control panel's icon, with a gear for the Settings key; without the icon, the
 * key keeps the manifest's own image. The counterpart of ApplySoundKeyIcon in AudioSwitcherStreamDeckPlugin.cpp.
 */
async function applySoundKeyIcon(ev: WillAppearEvent, withGear: boolean): Promise<void> {
	if (!ev.action.isKey()) return;
	const image = await soundKeyImage(withGear);
	if (!image) return;
	await ev.action.setImage(image).catch((error) => streamDeck.logger.error("Failed to set image", error));
}

function showAlert(ev: KeyUpEvent): () => void {
	return () => {
		ev.action.showAlert().catch(() => undefined);
	};
}

/** Opens the classic Sound control panel (mmsys.cpl). */
@action({ UUID: `${PLUGIN_UUID}.soundcontrolpanel` })
export class SoundControlPanelAction extends SingletonAction {
	override async onWillAppear(ev: WillAppearEvent): Promise<void> {
		await applySoundKeyIcon(ev, false);
	}

	override onKeyUp(ev: KeyUpEvent): void {
		openSoundControlPanel(showAlert(ev));
	}
}

/** Opens Sound in the Windows Settings app. */
@action({ UUID: `${PLUGIN_UUID}.soundsettings` })
export class SoundSettingsAction extends SingletonAction {
	override async onWillAppear(ev: WillAppearEvent): Promise<void> {
		await applySoundKeyIcon(ev, true);
	}

	override onKeyUp(ev: KeyUpEvent): void {
		openSoundSettings(showAlert(ev));
	}
}
