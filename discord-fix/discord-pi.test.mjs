import assert from "node:assert/strict";
import path from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const DISCORD_PLUGIN_DIR = process.env.DISCORD_PLUGIN_DIR
  ?? path.join(process.env.APPDATA, "Elgato", "StreamDeck", "Plugins", "com.elgato.discord.sdPlugin");
const PROPERTY_INSPECTOR_URL = pathToFileURL(path.join(DISCORD_PLUGIN_DIR, "inspectors", "index.html")).href;

const FAKE_STREAM_DECK_SOCKET = `
  window.sentToStreamDeck = [];
  window.WebSocket = class {
    constructor() { window.streamDeckSocket = this; setTimeout(() => this.onopen(), 0); }
    send(data) { window.sentToStreamDeck.push(JSON.parse(data)); }
  };
`;
const SECONDS_UNTIL_THE_PANEL_SAVES_ON_ITS_OWN = 1.2;

let browser;
before(async () => {
  browser = await chromium.launch({ channel: "chrome" });
});
after(() => browser?.close());

async function openSetAudioDevicePanel(settings, devices) {
  const page = await browser.newPage();
  await page.addInitScript(FAKE_STREAM_DECK_SOCKET);
  await page.goto(PROPERTY_INSPECTOR_URL);
  const info = JSON.stringify({ application: { language: "en" } });
  const actionInfo = JSON.stringify({ action: "com.elgato.discord.setaudiodevice", payload: { settings } });
  await page.evaluate(`connectElgatoStreamDeckSocket(0, "pi", "registerPropertyInspector", ${JSON.stringify(info)}, ${JSON.stringify(actionInfo)})`);
  const message = JSON.stringify({ event: "sendToPropertyInspector", payload: devices });
  await page.evaluate(`streamDeckSocket.onmessage({ data: ${JSON.stringify(message)} })`);
  await page.waitForTimeout(SECONDS_UNTIL_THE_PANEL_SAVES_ON_ITS_OWN * 1000);
  return page;
}

async function optionLabels(page, selectId) {
  return page.locator(`#${selectId} option:not([disabled])`).allInnerTexts();
}

async function lastSavedSettings(page) {
  return page.evaluate("window.sentToStreamDeck.filter((message) => message.event === 'setSettings').at(-1).payload");
}

const headsetMicName = "Microfone do Headset (CORSAIR HS80 RGB Wireless Gaming Receiver)";
const headsetMicBeforeWindowsRecreatedIt = "{0.0.1.00000000}.{489f7db2-69a0-43be-9dde-b8f2145af8e4}";
const headsetMicNow = { id: "{0.0.1.00000000}.{845435b3-32b5-4cc7-9f1e-245ec66ca453}", name: headsetMicName };
const fifineNow = { id: "{0.0.1.00000000}.{9f7761b6-eb45-4384-b999-9984a4970a9b}", name: "FIFINE MICROFONE (USB PnP Audio Device)" };
const dacNow = { id: "{0.0.0.00000000}.{75311d37-e328-4b73-a5b9-0a835f8b7ed8}", name: "Alto-falantes (SMSL USB DAC)" };

test("a device Windows re-created under a new ID shows once and is saved under its new ID", async () => {
  const page = await openSetAudioDevicePanel(
    { mode: "input", input: headsetMicBeforeWindowsRecreatedIt, inputname: headsetMicName },
    { inputs: [headsetMicNow, fifineNow], outputs: [dacNow] }
  );

  assert.deepEqual(await optionLabels(page, "input"), [fifineNow.name, headsetMicName].sort());
  assert.equal(await page.locator("#input").inputValue(), headsetMicNow.id);
  assert.equal((await lastSavedSettings(page)).input, headsetMicNow.id);
  await page.close();
});

test("a re-created device that lost its \"N- \" prefix shows once, under its current name", async () => {
  const page = await openSetAudioDevicePanel(
    {
      mode: "both",
      input: "{0.0.1.00000000}.{e288beeb-8f63-4269-8914-cabc23f5ae99}",
      inputname: "FIFINE MICROFONE (4- USB PnP Audio Device)",
      output: dacNow.id,
      outputname: "Alto-falantes (5- SMSL USB DAC)"
    },
    {
      inputs: Object.fromEntries([headsetMicNow, fifineNow].map((device) => [device.id, { name: device.name }])),
      outputs: Object.fromEntries([dacNow].map((device) => [device.id, { name: device.name }]))
    }
  );

  assert.deepEqual(await optionLabels(page, "input"), [fifineNow.name, headsetMicName].sort());
  assert.deepEqual(await optionLabels(page, "output"), [dacNow.name]);
  const saved = await lastSavedSettings(page);
  assert.equal(saved.input, fifineNow.id);
  assert.equal(saved.inputname, fifineNow.name);
  assert.equal(saved.outputname, dacNow.name);
  await page.close();
});

test("a device that is really unplugged keeps its saved entry instead of switching to another one", async () => {
  const page = await openSetAudioDevicePanel(
    { mode: "input", input: headsetMicBeforeWindowsRecreatedIt, inputname: headsetMicName },
    { inputs: [fifineNow], outputs: [dacNow] }
  );

  assert.equal(await page.locator("#input").inputValue(), headsetMicBeforeWindowsRecreatedIt);
  assert.equal((await lastSavedSettings(page)).input, headsetMicBeforeWindowsRecreatedIt);
  await page.close();
});
