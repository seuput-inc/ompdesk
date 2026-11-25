import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { stopCore } from "./core/process";
import { PrefsStore } from "./prefs-store";

const dir = mkdtempSync(join(tmpdir(), "prefs-store-"));
let file = "";
let count = 0;

beforeEach(() => {
	file = join(dir, `prefs-${++count}.json`);
});

afterAll(async () => {
	await stopCore();
	rmSync(dir, { recursive: true, force: true });
});

describe("the preference files the core owns", () => {
	it("reads a change in the same tick, a dotted key as a nested path", () => {
		writeFileSync(file, JSON.stringify({ theme: "dark", gui: { sidebar: true } }));
		const prefs = new PrefsStore<Record<string, unknown>>(file);
		const other = new PrefsStore<Record<string, unknown>>(file);

		prefs.set("gui.panelWidth", 320);
		prefs.set("mobileWeb.confirmNewDevices", false);
		expect(other.get("gui")).toEqual({ sidebar: true, panelWidth: 320 });
		expect(other.get("mobileWeb.confirmNewDevices")).toBe(false);
		expect(prefs.has("gui.sidebar")).toBe(true);

		prefs.delete("gui.sidebar");
		prefs.delete("theme");
		expect(prefs.has("gui.sidebar")).toBe(false);
		expect(prefs.get("theme", "light")).toBe("light");
		expect(prefs.store).toEqual({ gui: { panelWidth: 320 }, mobileWeb: { confirmNewDevices: false } });
	});

	it("answers a copy, refuses undefined and keeps a null", () => {
		const prefs = new PrefsStore<Record<string, unknown>>(file);
		prefs.set("layout", { tabs: ["a"] });
		const read = prefs.get("layout") as { tabs: string[] };
		read.tabs.push("b");
		expect(prefs.get("layout")).toEqual({ tabs: ["a"] });

		expect(() => prefs.set("layout", undefined)).toThrow("Use `delete()` to clear values");
		prefs.set("cleared", null);
		expect(prefs.has("cleared")).toBe(true);
		expect(prefs.get("cleared", "fallback")).toBeNull();
	});

	it("writes every change to the file in electron-store's format before the core exits", async () => {
		writeFileSync(file, JSON.stringify({ keep: 1 }));
		const prefs = new PrefsStore<Record<string, unknown>>(file);
		prefs.set("language", "ko");
		prefs.store = { ...prefs.store, proxyUrl: "http://proxy" };
		await stopCore();

		expect(readFileSync(file, "utf8")).toBe(
			JSON.stringify({ keep: 1, language: "ko", proxyUrl: "http://proxy" }, undefined, "\t"),
		);
		// The next core reads it back.
		expect(prefs.get("proxyUrl")).toBe("http://proxy");
	});

	it("answers a change made through another store of the same file, nested or escaped, in the same tick", () => {
		writeFileSync(file, `\uFEFF${JSON.stringify({ gui: { panelWidth: 300 }, language: "en", "a.b": 1 })}`);
		const reader = new PrefsStore<Record<string, unknown>>(file);
		const writer = new PrefsStore<Record<string, unknown>>(file);
		expect(reader.get("gui.panelWidth")).toBe(300);
		expect(reader.get("gui")).toEqual({ panelWidth: 300 });
		expect(reader.get("a\\.b")).toBe(1);
		expect(reader.store).toEqual({ gui: { panelWidth: 300 }, language: "en", "a.b": 1 });

		writer.set("gui", { panelWidth: 420 });
		expect(reader.get("gui.panelWidth")).toBe(420);
		writer.set("a\\.b", 2);
		expect(reader.get("a\\.b")).toBe(2);
		writer.delete("language");
		expect(reader.has("language")).toBe(false);
		expect(reader.store).toEqual({ gui: { panelWidth: 420 }, "a.b": 2 });
	});

	it("refuses a key no value can be written to, and conf's own bookkeeping", () => {
		const prefs = new PrefsStore<Record<string, unknown>>(file);
		expect(() => prefs.set("a[1", 1)).toThrow("The key `a[1` is not a key a value can be written to.");
		expect(() => prefs.set("__internal__.migrations", 1)).toThrow(/__internal__ key/);
		prefs.set("__proto__.polluted", true);
		expect(prefs.store).toEqual({});
	});

	it("reads a key owner's change in the same tick, and its refusal keeps the page's error code", () => {
		const prefs = new PrefsStore<Record<string, unknown>>(file);
		const cwd = join(dir, "work");
		expect(prefs.get("launchProfiles")).toBeUndefined();
		expect(prefs.updateLaunchProfile(cwd, { noRules: true, profile: " p " })).toEqual({
			noRules: true,
			profile: "p",
		});
		expect(prefs.get("launchProfiles")).toEqual({ [cwd]: { noRules: true, profile: "p" } });
		expect(prefs.launchFlags(cwd)).toEqual(["--no-rules", "--profile", "p"]);
		expect(() => prefs.launchProfile("relative")).toThrow("[invalid_launch_profile] Invalid workspace");

		expect(prefs.get("sidebar")).toBeUndefined();
		const pinned = prefs.updateSidebar({ op: "set-session-pinned", path: "/s/1", pinned: true }, "window");
		expect(pinned.change).toEqual({ op: "set-session-pinned", path: "/s/1", pinned: true });
		expect(prefs.get("sidebar")).toMatchObject({ pinnedSessions: ["/s/1"] });
		expect(prefs.moveSidebarPin("/s/1", "/s/2")).toBe(true);
		expect(prefs.get("sidebar")).toMatchObject({ pinnedSessions: ["/s/2"] });
		expect(() => prefs.updateSidebar({ op: "set-everything" }, "web")).toThrow(
			"[invalid_preference_key] Invalid sidebar change",
		);
	});
});
