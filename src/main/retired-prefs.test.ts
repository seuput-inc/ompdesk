import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { stopCore } from "./core/process";
import { PrefsStore } from "./prefs-store";

// The migration runs in the core each time it reads prefs.json from disk (crates/core/src/prefs/retired.rs), before
// any caller sees the store: what a launch reading this file would see.
const root = mkdtempSync(join(tmpdir(), "retired-prefs-"));
let count = 0;

afterAll(async () => {
	await stopCore();
	rmSync(root, { recursive: true, force: true });
});

function profile(prefs: Record<string, unknown>): { dir: string; file: string; text: string } {
	const dir = join(root, String(++count));
	const file = join(dir, "prefs.json");
	const text = JSON.stringify(prefs);
	mkdirSync(dir);
	writeFileSync(file, text);
	return { dir, file, text };
}

function migrated(prefs: Record<string, unknown>): Record<string, unknown> {
	return new PrefsStore(profile(prefs).file).store;
}

describe("prefs a launch no longer reads", () => {
	it("turns off wakes of the former bot's current conversations once, keeping every schedule and other session's wakes", async () => {
		const { dir, file } = profile({
			bot: "/s/main.jsonl",
			botEnabled: false,
			botConversations: {
				current: { side: { path: "/s/side.jsonl" }, main: { path: "/s/current.jsonl" } },
				past: [{ path: "/s/past.jsonl" }],
			},
			botRules: [],
		});
		const schedulesFile = join(dir, "schedules.json");
		const schedules = [
			{ id: "main", wakeSession: "/s/main.jsonl", enabled: true },
			{ id: "side", wakeSession: "/s/side.jsonl", enabled: true },
			{ id: "current", wakeSession: "/s/current.jsonl", enabled: true },
			{ id: "past", wakeSession: "/s/past.jsonl", enabled: true },
			{ id: "self", wakeSession: "/s/ordinary.jsonl", enabled: true },
			{ id: "fresh", enabled: true },
		];
		writeFileSync(schedulesFile, JSON.stringify({ version: 1, schedules, runs: [] }));
		const prefs = new PrefsStore(file);
		expect(prefs.store).toEqual({});
		const once = JSON.parse(readFileSync(schedulesFile, "utf8"));
		expect(once.schedules).toEqual(
			schedules.map((schedule, index) => (index < 3 ? { ...schedule, enabled: false } : schedule)),
		);
		expect(once.runs).toEqual([]);

		// The next launch: the bot's keys are gone, so a schedule turned on again stays on.
		await stopCore();
		once.schedules[0].enabled = true;
		writeFileSync(schedulesFile, JSON.stringify(once));
		expect(prefs.store).toEqual({});
		expect(JSON.parse(readFileSync(schedulesFile, "utf8"))).toEqual(once);
	});

	it("retires the stored memory and learning switches of an older version: a stored off no longer matters", () => {
		expect(
			migrated({
				aiMemory: false,
				aiMemoryLearn: false,
				aiMemoryServiceOwned: false,
				aiMemoryTerminal: true,
				language: "ko",
			}),
		).toEqual({ aiMemoryTerminal: true, language: "ko" });
	});

	it("keeps tools up to date unless all three update switches were off", () => {
		expect(migrated({ ompAutoUpdate: false, cliAutoUpdate: false, extensionAutoUpdate: false })).toEqual({
			toolsAutoUpdate: false,
		});
		expect(migrated({ ompAutoUpdate: false, cliAutoUpdate: true, extensionAutoUpdate: false })).toEqual({});
		expect(migrated({ ompAutoUpdate: false, cliAutoUpdate: false })).toEqual({});
		expect(
			migrated({ toolsAutoUpdate: true, ompAutoUpdate: false, cliAutoUpdate: false, extensionAutoUpdate: false }),
		).toEqual({ toolsAutoUpdate: true });
	});

	it("asks before new devices when either approval switch was on", () => {
		expect(migrated({ remote: { confirmNewDevices: true, keepAwake: false } })).toEqual({
			remote: {},
			mobileWeb: { confirmNewDevices: true },
		});
		expect(migrated({ remote: { confirmNewDevices: false }, mobileWeb: { confirmNewDevices: true } })).toEqual({
			remote: {},
			mobileWeb: { confirmNewDevices: true },
		});
		expect(migrated({ remote: { confirmNewDevices: false } })).toEqual({ remote: {} });
	});

	it("keeps one keep-awake switch: a stored host on turns a stored-off work switch on, an untouched host does not", () => {
		expect(migrated({ keepAwakeWhileWorking: false, remote: { keepAwake: true } })).toEqual({
			keepAwakeWhileWorking: true,
			remote: {},
		});
		expect(migrated({ keepAwakeWhileWorking: false })).toEqual({ keepAwakeWhileWorking: false });
		expect(migrated({ remote: { keepAwake: false } })).toEqual({ remote: {} });
		const bothOff = migrated({ keepAwakeWhileWorking: false, remote: { keepAwake: false } });
		expect(bothOff).toEqual({ keepAwakeWhileWorking: false, remote: {} });
		expect(migrated(bothOff)).toEqual(bothOff);
	});

	it("drops the run-state and progress switches and the work board switch, keeping other display preferences", () => {
		expect(
			migrated({
				workBoard: false,
				displayPreferences: { titleState: false, showProgress: true, showTokenUsage: true },
			}),
		).toEqual({ displayPreferences: { showTokenUsage: true } });
	});

	it("forgets a default side panel view and the shortcuts of the views the panel no longer holds", () => {
		const once = migrated({
			defaultPanelTab: "jobs",
			keymapOverrides: { "panel.jobs": ["⌥1"], "panel.memory": ["⌥2"], "panel.terminal": ["⌥3"] },
		});
		expect(once).toEqual({ keymapOverrides: { "panel.terminal": ["⌥3"] } });
		expect(migrated(once)).toEqual(once);
		expect(migrated({ defaultPanelTab: "files" })).toEqual({ defaultPanelTab: "files" });
	});

	it("writes nothing to prefs that hold no retired key and an already merged value", async () => {
		const clean = profile({
			language: "en",
			mobileWeb: { confirmNewDevices: true },
			toolsAutoUpdate: false,
			keymapOverrides: { "panel.terminal": ["⌥3"] },
		});
		const retired = profile({ language: "en", workBoard: false });
		expect(new PrefsStore(clean.file).get("language")).toBe("en");
		expect(new PrefsStore(retired.file).has("workBoard")).toBe(false);
		await stopCore();
		expect(readFileSync(clean.file, "utf8")).toBe(clean.text);
		expect(JSON.parse(readFileSync(retired.file, "utf8"))).toEqual({ language: "en" });
	});
});
