import streamDeck from "@elgato/streamdeck";

import { SoundControlPanelAction, SoundSettingsAction } from "./actions/open-sound-settings";
import { SetDeviceAction } from "./actions/set-device";
import { ToggleDeviceAction } from "./actions/toggle-device";

streamDeck.actions.registerAction(new SetDeviceAction());
streamDeck.actions.registerAction(new ToggleDeviceAction());
streamDeck.actions.registerAction(new SoundControlPanelAction());
streamDeck.actions.registerAction(new SoundSettingsAction());

streamDeck.connect();
