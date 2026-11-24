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

	it("reads a file edited on disk while it runs", async () => {
		const prefs = new PrefsStore<Record<string, unknown>>(file);
		prefs.set("ompFollowVerified", false);
		await stopCore();
		writeFileSync(file, JSON.stringify({ ompFollowVerified: true }));
		expect(prefs.get("ompFollowVerified")).toBe(true);
		writeFileSync(file, `\uFEFF${JSON.stringify({ ompFollowVerified: false, extra: [1] })}`);
		expect(prefs.store).toEqual({ ompFollowVerified: false, extra: [1] });
	});

	it("refuses a key no value can be written to, and conf's own bookkeeping", () => {
		const prefs = new PrefsStore<Record<string, unknown>>(file);
		expect(() => prefs.set("a[1", 1)).toThrow("The key `a[1` is not a key a value can be written to.");
		expect(() => prefs.set("__internal__.migrations", 1)).toThrow(/__internal__ key/);
		prefs.set("__proto__.polluted", true);
		expect(prefs.store).toEqual({});
	});
});
