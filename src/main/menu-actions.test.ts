/**
 * Native menu wiring: every MENU_ACTION the shell's app menu sends (`tauri-shell/src/app_menu.rs`) must be a declared
 * MenuAction with a branch in the renderer's dispatcher (App.tsx), so a redesign that removes an opener cannot leave a
 * menu item that does nothing; and the menu's accelerators are the chords the keymap reserves for it.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NATIVE_CHORDS } from "../shared/hotkeys";
import { PRODUCT_REPO_URL } from "../shared/product-repo";

const SRC = path.resolve(__dirname, "..");
const APP_MENU = fs.readFileSync(path.join(SRC, "../native/ompdesk/crates/tauri-shell/src/app_menu.rs"), "utf8");
/** The menu's source without its tests. */
const MENU = APP_MENU.slice(0, APP_MENU.indexOf("#[cfg(test)]"));

/** First capture group of every match of `pattern` in `src/<file>` (or in a given string). */
function captures(file: string, pattern: RegExp, source = fs.readFileSync(path.join(SRC, file), "utf8")): string[] {
	return [...source.matchAll(pattern)].map(match => match[1]);
}

const union = /export type MenuAction =([^;]+);/.exec(
	fs.readFileSync(path.join(SRC, "shared/ipc-types.ts"), "utf8"),
)?.[1];
const declared = captures("", /"([a-z-]+)"/g, union ?? "");
const menuSent = [
	...captures("", /\bpage\(\s*"menu\.\w+",\s*"([a-z-]+)"\s*\)/g, MENU),
	...captures("", /Action::Page\("([a-z-]+)"\)/g, MENU),
];
const handled = captures("renderer/App.tsx", /action === "([a-z-]+)"/g);

describe("menu actions", () => {
	it("finds the declared actions and their senders", () => {
		expect(declared.length).toBeGreaterThan(20);
		expect(menuSent.length).toBeGreaterThan(20);
	});

	it("sends only declared actions", () => {
		for (const action of menuSent) expect(declared, action).toContain(action);
	});

	it("handles every declared action in the renderer", () => {
		for (const action of declared) expect(handled, action).toContain(action);
	});

	it("declares no action that the menu does not send", () => {
		for (const action of declared) expect(menuSent, action).toContain(action);
	});

	it("gives the menu the chords the keymap reserves for it", () => {
		for (const chord of NATIVE_CHORDS) {
			// The shell registers the window toggle itself (entry.rs): never a menu accelerator.
			if (chord.id === "window.toggle") expect(MENU).not.toContain(`"${chord.accelerator}"`);
			else expect(MENU, chord.id).toContain(`Some("${chord.accelerator}")`);
		}
	});

	it("opens the product's repository for Documentation", () => {
		expect(MENU).toContain(`const DOCUMENTATION: &str = "${PRODUCT_REPO_URL}";`);
	});
});
