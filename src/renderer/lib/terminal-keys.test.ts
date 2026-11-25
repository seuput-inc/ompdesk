/** The phone's Terminal key bar: byte sequences, sticky modifiers and the font scale. */
import { describe, expect, it } from "vitest";
import {
	applyModifiers,
	clampFontScale,
	controlCharacter,
	FONT_SCALE_MAX,
	FONT_SCALE_MIN,
	fontSizeFor,
	isSingleKey,
	KEY_USE_STORAGE,
	keysByUse,
	noteKeyUse,
	optionWordMotion,
	readKeyUse,
	TERMINAL_KEYS,
	zoomKey,
} from "./terminal-keys";

const NONE = { ctrl: false, alt: false };

describe("TERMINAL_KEYS", () => {
	it("has the keys a soft keyboard lacks, with unique ids and the bytes a PTY expects", () => {
		const byId = new Map(TERMINAL_KEYS.map(key => [key.id, key]));
		expect(byId.size).toBe(TERMINAL_KEYS.length);
		expect(byId.get("esc")?.data).toBe("\x1b");
		expect(byId.get("tab")?.data).toBe("\t");
		expect(byId.get("shift-tab")?.data).toBe("\x1b[Z");
		expect(byId.get("up")?.data).toBe("\x1b[A");
		expect(byId.get("down")?.data).toBe("\x1b[B");
		expect(byId.get("right")?.data).toBe("\x1b[C");
		expect(byId.get("left")?.data).toBe("\x1b[D");
		expect(byId.get("ctrl-c")?.data).toBe("\x03");
		expect(byId.get("ctrl")?.modifier).toBe("ctrl");
		expect(byId.get("alt")?.modifier).toBe("alt");
		for (const symbol of [
			"|",
			"~",
			"/",
			"\\",
			"-",
			"_",
			"$",
			"&",
			"*",
			"^",
			"<",
			">",
			"{",
			"}",
			"[",
			"]",
			"(",
			")",
			":",
			";",
			'"',
			"'",
		]) {
			expect(
				TERMINAL_KEYS.some(key => key.data === symbol),
				symbol,
			).toBe(true);
		}
		expect(TERMINAL_KEYS.filter(key => key.repeat).map(key => key.id)).toEqual(["left", "down", "up", "right"]);
	});
});

describe("applyModifiers", () => {
	it("leaves data alone with nothing held", () => {
		expect(applyModifiers("a", NONE)).toBe("a");
		expect(applyModifiers("\x1b[A", NONE)).toBe("\x1b[A");
	});

	it("turns a letter into its control character with Ctrl", () => {
		expect(applyModifiers("c", { ctrl: true, alt: false })).toBe("\x03");
		expect(applyModifiers("D", { ctrl: true, alt: false })).toBe("\x04");
		expect(applyModifiers("[", { ctrl: true, alt: false })).toBe("\x1b");
		expect(applyModifiers("\\", { ctrl: true, alt: false })).toBe("\x1c");
		expect(applyModifiers(" ", { ctrl: true, alt: false })).toBe("\x00");
		expect(applyModifiers("1", { ctrl: true, alt: false })).toBe("1");
	});

	it("prefixes Esc for Alt, and combines both", () => {
		expect(applyModifiers("f", { ctrl: false, alt: true })).toBe("\x1bf");
		expect(applyModifiers("b", { ctrl: true, alt: true })).toBe("\x1b\x02");
	});

	it("puts the modifier in an arrow's escape sequence", () => {
		expect(applyModifiers("\x1b[A", { ctrl: true, alt: false })).toBe("\x1b[1;5A");
		expect(applyModifiers("\x1b[D", { ctrl: false, alt: true })).toBe("\x1b[1;3D");
		expect(applyModifiers("\x1b[C", { ctrl: true, alt: true })).toBe("\x1b[1;7C");
		expect(applyModifiers("\x1b[H", { ctrl: true, alt: false })).toBe("\x1b[1;5H");
	});

	it("never modifies a paste or other multi-character data", () => {
		expect(applyModifiers("hello world", { ctrl: true, alt: true })).toBe("hello world");
		expect(applyModifiers("\x1b[5~", { ctrl: true, alt: false })).toBe("\x1b[5~");
	});
});

describe("controlCharacter / isSingleKey", () => {
	it("knows the control characters and which data is one key", () => {
		expect(controlCharacter("a")).toBe("\x01");
		expect(controlCharacter("?")).toBe("\x7f");
		expect(controlCharacter("é")).toBeNull();
		expect(controlCharacter("ab")).toBeNull();
		expect(isSingleKey("x")).toBe(true);
		expect(isSingleKey("\x1b[A")).toBe(true);
		expect(isSingleKey("\x1b[5~")).toBe(true);
		expect(isSingleKey("ls -la")).toBe(false);
	});
});

describe("font scale", () => {
	it("is held to 50–200 % in steps of 10 and sizes the font from a 12 px base", () => {
		expect(clampFontScale(10)).toBe(FONT_SCALE_MIN);
		expect(clampFontScale(999)).toBe(FONT_SCALE_MAX);
		expect(clampFontScale(113)).toBe(110);
		expect(clampFontScale(Number.NaN)).toBe(100);
		expect(fontSizeFor(100)).toBe(12);
		expect(fontSizeFor(50)).toBe(6);
		expect(fontSizeFor(200)).toBe(24);
		expect(fontSizeFor(150)).toBe(18);
	});
});

describe("keys by use", () => {
	it("puts the keys this device presses most first, the rest in the bar's own order, and survives bad storage", () => {
		const store = new Map<string, string>();
		const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: store.set.bind(store) };
		noteKeyUse(storage, "ctrl-c");
		noteKeyUse(storage, "ctrl-c");
		noteKeyUse(storage, "up");
		expect(readKeyUse(storage)).toEqual({ "ctrl-c": 2, up: 1 });
		const ids = keysByUse(readKeyUse(storage)).map(key => key.id);
		expect(ids.slice(0, 4)).toEqual(["ctrl-c", "up", "esc", "tab"]);
		expect(ids).toHaveLength(TERMINAL_KEYS.length);
		store.set(KEY_USE_STORAGE, "{not json");
		expect(readKeyUse(storage)).toEqual({});
	});
});

describe("desktop terminal keys", () => {
	const key = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
	it("turns the US Option layer's ∫ ƒ ∂ into readline's word motions and leaves composed text alone", () => {
		expect(optionWordMotion({ ...key, altKey: true, code: "KeyB", key: "∫" })).toBe("\x1bb");
		expect(optionWordMotion({ ...key, altKey: true, code: "KeyF", key: "ƒ" })).toBe("\x1bf");
		// With Shift, or on a layout whose Option key types something else, it stays a character.
		expect(optionWordMotion({ ...key, altKey: true, code: "KeyF", key: "ƒ", shiftKey: true })).toBeNull();
		expect(optionWordMotion({ ...key, altKey: true, code: "KeyE", key: "´" })).toBeNull();
		expect(optionWordMotion({ ...key, altKey: true, code: "KeyB", key: "b" })).toBeNull();
	});
	it("reads ⌘ = − 0 on macOS and Ctrl on Windows as the terminal's text size", () => {
		expect(zoomKey({ ...key, metaKey: true, key: "=" }, true)).toBe("larger");
		expect(zoomKey({ ...key, metaKey: true, key: "-" }, true)).toBe("smaller");
		expect(zoomKey({ ...key, ctrlKey: true, key: "0" }, false)).toBe("reset");
		expect(zoomKey({ ...key, ctrlKey: true, key: "=" }, true)).toBeNull();
		expect(zoomKey({ ...key, metaKey: true, key: "c" }, true)).toBeNull();
	});
});
