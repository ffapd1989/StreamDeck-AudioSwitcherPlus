# Discord plugin fix

Elgato's own Discord plugin (`com.elgato.discord`) has the duplicate-device bug this repo's property inspector already handles. When Windows re-creates an audio endpoint (another USB port, a driver update), the device comes back under a new ID, sometimes with its "N- " prefix changed. The "Set Audio Device" key keeps the old ID, so its settings list shows the device twice (the saved, dead entry and the live one), and pressing the key doesn't switch Discord, which no longer knows that ID.

[`apply.mjs`](apply.mjs) patches that action's property inspector (`inspectors/setAudioDevicePI.js` in the installed plugin). On open, a saved device is matched to a live one (same ID, else same name ignoring the "N- " prefix, else the only device on that interface) and saved under its current ID and name. A device that is really unplugged keeps its saved entry. The script keeps the original as `setAudioDevicePI.js.orig`, does nothing if the fix is already there, and changes nothing (exit code 1) if Elgato rewrote the file so the fix no longer fits.

## Limits

- A key is repaired only when its settings are opened: the plugin itself is a compiled, encrypted exe. After Windows re-creates a device, open each Discord "Set Audio Device" key once.
- A Discord plugin update replaces the file. [`register-logon-task.ps1`](register-logon-task.ps1) registers a scheduled task that re-applies the fix at every logon; run it once per machine. Between an update and the next logon, run `npm run apply` here.

## Undo

Copy `setAudioDevicePI.js.orig` back over `setAudioDevicePI.js` (or reinstall the plugin from the Marketplace), and remove the task with `Unregister-ScheduledTask 'Reapply Discord Set Audio Device fix'`.

## Tests

`npm install`, then `npm test`. The tests load the installed plugin's property inspector in Chrome with a fake Stream Deck socket; set `DISCORD_PLUGIN_DIR` to test another copy of the plugin.
