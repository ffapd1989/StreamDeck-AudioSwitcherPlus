import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const pluginDir = process.argv[2]
  ?? path.join(process.env.APPDATA, "Elgato", "StreamDeck", "Plugins", "com.elgato.discord.sdPlugin");
const file = path.join(pluginDir, "inspectors", "setAudioDevicePI.js");
const original = readFileSync(file, "latin1");

if (original.includes("useLiveAudioDevice")) {
  console.log(`Fix already applied: ${file}`);
  process.exit(0);
}

const helpersAnchor = "    var piLoad = this.load;";
const loadAnchor = "        if (!data.disabled && !data.unauthorized) {";
for (const anchor of [helpersAnchor, loadAnchor]) {
  if (original.split(anchor).length !== 2) {
    console.error(`The Discord plugin changed and the fix no longer knows where to go ("${anchor.trim()}" not found once). Nothing was changed.`);
    process.exit(1);
  }
}

const eol = original.includes("\r\n") ? "\r\n" : "\n";
const helpers = [
  "    function splitDeviceName(name) {",
  "        const match = /^(.*) \\((?:\\d+- )?(.*)\\)$/.exec(name || \"\");",
  "        return match ? { endpoint: match[1], interface: match[2] } : undefined;",
  "    }",
  "",
  "    function useLiveAudioDevice(key, list) {",
  "        const devices = (Array.isArray(list) ? list : Object.entries(list || {}).map(([id, device]) => Object.assign({ id: id }, device)))",
  "            .filter(device => device && device.id && device.name);",
  "        const saved = splitDeviceName(settings[key + \"name\"]);",
  "        const sameInterface = saved ? devices.filter(device => splitDeviceName(device.name)?.interface === saved.interface) : [];",
  "        const live = devices.find(device => device.id === settings[key])",
  "            || sameInterface.find(device => splitDeviceName(device.name).endpoint === saved.endpoint)",
  "            || (sameInterface.length === 1 ? sameInterface[0] : undefined);",
  "        if (!live || (live.id === settings[key] && live.name === settings[key + \"name\"])) return false;",
  "        settings[key] = live.id;",
  "        settings[key + \"name\"] = live.name;",
  "        return true;",
  "    }",
  "",
  ""
].join(eol);
const resolveOnLoad = [
  "",
  "            const inputChanged = useLiveAudioDevice(\"input\", data.inputs);",
  "            const outputChanged = useLiveAudioDevice(\"output\", data.outputs);",
  "            if (inputChanged || outputChanged) piSaveSettings();"
].join(eol);

const patched = original
  .replace(helpersAnchor, () => helpers + helpersAnchor)
  .replace(loadAnchor, () => loadAnchor + resolveOnLoad);

if (!existsSync(`${file}.orig`)) copyFileSync(file, `${file}.orig`);
writeFileSync(file, patched, "latin1");
console.log(`Fix applied: ${file}`);
