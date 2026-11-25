/**
 * Every program main and the bridge start on Windows starts without a console window (`windowsHide: true`): one
 * started without it by a parent that has no console opens a black window on the person's desktop. A start that needs
 * none is in `WINDOWLESS` with the reason. What still shows at run time leaves a line (console-window-watch.ts).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../..");
const FOLDERS = ["src/main", "src/preload", "resources/gui-bridge"];
/** Tests and their rigs start programs on a developer's computer, never in the app. */
const NOT_THE_APP = /\.test\.|(^|\/)test-|-harness\.ts$|-rig\.ts$|\/formal\/|\.d\.ts$/;
const START = /(^|[^.\w#])(spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\(/g;

/** The starts that pass no `windowsHide`, as `file: first argument`, each with why it opens no console window. */
const WINDOWLESS: Record<string, string> = {
	"src/main/installer-spawn.ts: workerData.command": "the NSIS setup, a window program whose own window must show",
	"src/main/shell-env.ts: shell": "the login shell's environment, macOS and Linux only",
	"src/main/updater.ts: command":
		"the NSIS setup started at an approved quit (or elevate.exe, which asks UAC for it), as electron-updater started them",
	'src/main/updater.ts: "/bin/bash"': "the relaunch swap, macOS only",
	'src/main/power/lid-awake-runtime.ts: "/usr/bin/caffeinate"': "macOS only",
};

function sources(folder: string): string[] {
	return readdirSync(join(ROOT, folder), { recursive: true, encoding: "utf8" })
		.map(name => `${folder}/${name.replaceAll("\\", "/")}`)
		.filter(file => /\.(ts|mts|js|mjs)$/.test(file) && !NOT_THE_APP.test(file) && !file.includes("node_modules"));
}

/** Each `child_process` start of `text` that passes no `windowsHide: true`, by its first argument. */
function shownStarts(text: string): string[] {
	if (!text.includes("child_process")) return [];
	const shown: string[] = [];
	for (const match of text.matchAll(START)) {
		const lineStart = text.lastIndexOf("\n", match.index) + 1;
		if (/^\s*(\/\/|\*|\/\*)/.test(text.slice(lineStart, match.index + match[0].length))) continue;
		const open = match.index + match[0].length;
		let depth = 1;
		let end = open;
		// The call's own parentheses; a parenthesis inside a string of it would only make the start read as shown.
		for (; end < text.length && depth > 0; end++) {
			if (text[end] === "(") depth++;
			else if (text[end] === ")") depth--;
		}
		const call = text.slice(open, end - 1);
		if (!/windowsHide:\s*true/.test(call)) shown.push(call.split(",")[0]?.trim() ?? "");
	}
	return shown;
}

describe("starts without a console window", () => {
	it("reads a start's own arguments", () => {
		const text = [
			'import { spawn, execFile } from "node:child_process";',
			'spawn("git", ["status"], { windowsHide: true });',
			"execFile(bin, args(1), {",
			"\ttimeout: 5,",
			"}, done);",
			"// spawn(commented)",
			"pattern.exec(text);",
		].join("\n");
		expect(shownStarts(text)).toEqual(["bin"]);
		expect(shownStarts('spawn("git")')).toEqual([]);
	});

	it("every program the app starts is started hidden, or says why it needs no hiding", () => {
		const shown = FOLDERS.flatMap(sources).flatMap(file =>
			shownStarts(readFileSync(join(ROOT, file), "utf8")).map(first => `${file}: ${first}`),
		);
		expect(shown.filter(start => !(start in WINDOWLESS))).toEqual([]);
		// A start that is gone, or hides its window now, leaves the list.
		expect(Object.keys(WINDOWLESS).filter(start => !shown.includes(start))).toEqual([]);
	});
});
