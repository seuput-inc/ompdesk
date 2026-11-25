/**
 * Native labels (the app menu, the text-field context menu, the tray) follow
 * the UI language and call each place by the name the window uses for it:
 * Electron's role items default to English whatever the language, and a menu
 * item that opens a page under another name reads as a different feature.
 * The shell's app menu and tray read their words from `native_labels.json`.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import NATIVE_LABELS from "../../native/ompdesk/crates/tauri-shell/src/native_labels.json";
import { en } from "../renderer/locales/en";
import { ko } from "../renderer/locales/ko";
import { UI_LANGUAGES } from "../shared/ui-language";
import { MAIN_TEXT } from "./i18n-text";

const RENDERER = { en, ko };
const NATIVE: Record<string, Record<string, string>> = NATIVE_LABELS;

/** Menus use title case and an ellipsis for items that ask for more; the words must match. */
const sameName = (native: string, renderer: string) =>
	native.replace(/…$/, "").toLowerCase() === renderer.replace(/…$/, "").toLowerCase();

describe("native menu roles", () => {
	it("labels every role item of the text-field context menu", () => {
		const source = fs.readFileSync(path.join(__dirname, "editable-context-menu.ts"), "utf8");
		expect(source.match(/\{\s*role: "\w+"(?: as const)?\s*\}/g) ?? []).toEqual([]);
	});

	it("keeps Electron's English role names in English", () => {
		const electronNames: Record<string, string> = {
			"menu.undo": "Undo",
			"menu.redo": "Redo",
			"menu.cut": "Cut",
			"menu.copy": "Copy",
			"menu.paste": "Paste",
			"menu.selectAll": "Select All",
			"menu.reload": "Reload",
			"menu.forceReload": "Force Reload",
			"menu.toggleDevTools": "Toggle Developer Tools",
			"menu.actualSize": "Actual Size",
			"menu.zoomIn": "Zoom In",
			"menu.zoomOut": "Zoom Out",
			"menu.toggleFullScreen": "Toggle Full Screen",
			"menu.minimize": "Minimize",
			"menu.zoom": "Zoom",
			"menu.bringAllToFront": "Bring All to Front",
		};
		for (const [key, name] of Object.entries(electronNames)) {
			expect(NATIVE[key]?.en, key).toBe(name);
			expect(NATIVE[key]?.ko, key).toMatch(/[가-힣]/);
		}
	});
});

describe("one name per place", () => {
	const menuPairs: [string, string][] = [
		["menu.newSession", "cmd.new"],
		["menu.newTab", "cmd.newTab"],
		["menu.newChatTab", "cmd.newChatTab"],
		["menu.openProject", "sidebar.project.open"],
		["menu.commandCenter", "help.palette"],
		["menu.contextReport", "cmd.context"],
		["menu.stats", "cmd.stats"],
		["menu.jobs", "cmd.jobs"],
		["menu.hotkeys", "help.shortcuts"],
		["menu.importSession", "cmd.import"],
		["menu.sessionTree", "cmd.tree"],
		["menu.sessionInfo", "cmd.session"],
		["menu.shareSession", "cmd.share"],
		["menu.exportHtml", "cmd.export"],
		["menu.handoff", "cmd.handoff"],
		["menu.agentHub", "cmd.agents"],
		["menu.modes", "cmd.modes"],
		["menu.providers", "settings.section.models"],
		["menu.modelRoles", "cmd.modelRoles"],
		["menu.capabilities", "settings.section.agent"],
		["menu.usage", "cmd.usage"],
		["menu.extensions", "cmd.extensions"],
		["menu.inventory", "cmd.plugins"],
		["menu.prCenter", "cmd.prCenter"],
		["menu.workspaceDirs", "settings.section.workspace"],
		["menu.workspaceChanges", "cmd.git"],
		["menu.restartCore", "cmd.restart"],
		["menu.debugConsole", "debug.title"],
		["menu.reportIssue", "help.feedback"],
	];
	for (const language of UI_LANGUAGES) {
		it(`names each menu item like the page it opens (${language})`, () => {
			for (const [key, rendererKey] of menuPairs) {
				const native = NATIVE[key]?.[language] ?? "";
				expect(sameName(native, RENDERER[language][rendererKey] ?? ""), `${key}: ${native}`).toBe(true);
			}
		});

		it(`names the tray's states like the composer (${language})`, () => {
			const tray = (status: string) => NATIVE[`tray.status${status}`]?.[language];
			expect(tray("Idle")).toBe(RENDERER[language]["titlebar.status.ready"]);
			expect(tray("Streaming")).toBe(RENDERER[language]["titlebar.status.working"]);
			expect(tray("Question")).toBe(RENDERER[language]["attention.question"]);
			expect(tray("Approval")).toBe(RENDERER[language]["attention.approval"]);
			expect(tray("ChildWaiting")).toBe(RENDERER[language]["attention.childWaiting"]);
			// The judge's "this reply waits for you" banner says the question word too.
			expect(
				MAIN_TEXT["notify.needsInput"][language].startsWith(`${RENDERER[language]["attention.question"]} · `),
			).toBe(true);
		});
		it(`names each palette command like the help menu and the window it opens (${language})`, () => {
			const strings = RENDERER[language];
			for (const [a, b] of [
				["cmd.changelog", "help.whatsNew"],
				["cmd.changelog", "changelog.title"],
				["cmd.feedback", "help.feedback"],
				["cmd.hotkeys", "help.shortcuts"],
			])
				expect(strings[a], `${a} / ${b}`).toBe(strings[b]);
		});
	}
});
