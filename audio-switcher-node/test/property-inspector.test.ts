import assert from "node:assert/strict";
import path from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import type { AudioDeviceInfo, ButtonSettings } from "../src/types.ts";

const PROPERTY_INSPECTOR_URL = pathToFileURL(path.resolve(import.meta.dirname, "../../shared/propertyinspector/index.html")).href;

const FAKE_STREAM_DECK_SOCKET = `
	window.sentToStreamDeck = [];
	window.WebSocket = class {
		constructor() { window.streamDeckSocket = this; setTimeout(() => this.onopen(), 0); }
		send(data) { window.sentToStreamDeck.push(JSON.parse(data)); }
	};
`;

let browser: Browser;
before(async () => {
	browser = await chromium.launch({ channel: "chrome" });
});
after(() => browser?.close());

function device(id: string, interfaceName: string, endpointName: string, state: AudioDeviceInfo["state"]): AudioDeviceInfo {
	return { id, interfaceName, endpointName, displayName: `${endpointName} (${interfaceName})`, direction: "output", state };
}

async function openSetKeyPanel(settings: Partial<ButtonSettings>, outputDevices: AudioDeviceInfo[]): Promise<Page> {
	const page = await browser.newPage();
	await page.addInitScript(FAKE_STREAM_DECK_SOCKET);
	await page.goto(PROPERTY_INSPECTOR_URL);
	const info = JSON.stringify({ plugin: { uuid: "com.morganscruggs.audioswitcherplus", version: "1.0.1.0" } });
	const actionInfo = JSON.stringify({ action: "com.morganscruggs.audioswitcherplus.set", payload: { settings } });
	await page.evaluate(`connectElgatoStreamDeckSocket(0, "pi", "registerPropertyInspector", ${JSON.stringify(info)}, ${JSON.stringify(actionInfo)})`);
	await page.waitForFunction("window.sentToStreamDeck.some((message) => message.payload?.event === 'getDeviceList')");
	const deviceList = {
		event: "sendToPropertyInspector",
		payload: { event: "getDeviceList", inputDevices: {}, outputDevices: Object.fromEntries(outputDevices.map((entry) => [entry.id, entry])) }
	};
	await page.evaluate(`streamDeckSocket.onmessage({ data: ${JSON.stringify(JSON.stringify(deviceList))} })`);
	return page;
}

async function optionValues(page: Page, selectId: string): Promise<(string | null)[]> {
	const options = await page.locator(`#${selectId} option`).all();
	return Promise.all(options.map((option) => option.getAttribute("value")));
}

async function lastSavedSettings(page: Page): Promise<ButtonSettings> {
	return page.evaluate("window.sentToStreamDeck.filter((message) => message.event === 'setSettings').at(-1).payload") as Promise<ButtonSettings>;
}

const dacBeforeWindowsRecreatedIt = device("{0.0.0.00000000}.{old-dac}", "2- SMSL USB DAC", "EDIFIER S1000MK2", "connected");
const dacAfterWindowsRecreatedIt = device("{0.0.0.00000000}.{new-dac}", "5- SMSL USB DAC", "Alto-falantes", "connected");

test("a device Windows re-created under a new ID shows once, as the live one, and is saved under its new ID", async () => {
	const page = await openSetKeyPanel(
		{
			direction: "output",
			role: "all",
			matchStrategy: "Fuzzy",
			hideDeviceType: true,
			primary: dacBeforeWindowsRecreatedIt,
			primaryLabel: "SMSL USB DAC",
			secondary: dacBeforeWindowsRecreatedIt,
			secondaryLabel: "SMSL USB DAC"
		},
		[{ ...dacBeforeWindowsRecreatedIt, state: "device_not_present" }, dacAfterWindowsRecreatedIt]
	);

	assert.deepEqual(await optionValues(page, "primaryDevice"), [dacAfterWindowsRecreatedIt.id]);
	assert.equal(await page.locator("#primaryDevice").inputValue(), dacAfterWindowsRecreatedIt.id);
	assert.equal((await lastSavedSettings(page)).primary?.id, dacAfterWindowsRecreatedIt.id);
	await page.close();
});

test("opening the panel keeps a saved device the plugin no longer lists, instead of erasing it", async () => {
	const headsetUnderItsOldInterfaceName = device("{0.0.0.00000000}.{old-headset}", "HS80 Receiver", "Headset", "connected");
	const page = await openSetKeyPanel(
		{ direction: "output", role: "all", matchStrategy: "Fuzzy", primary: headsetUnderItsOldInterfaceName, primaryLabel: "Headset (HS80 Receiver)" },
		[dacAfterWindowsRecreatedIt]
	);

	assert.deepEqual((await lastSavedSettings(page)).primary, headsetUnderItsOldInterfaceName);
	await page.close();
});
