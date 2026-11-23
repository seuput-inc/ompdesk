import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const binary = process.env.OMPDESK_TAURI_TEST_BINARY;

describe.skipIf(!binary)("legacy profile at Tauri startup", () => {
	let root: string;
	let appData: string;
	let profile: string;
	let legacy: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-user-data-"));
		appData =
			process.platform === "win32" ? path.join(root, "Roaming") : path.join(root, "Library/Application Support");
		profile = path.join(appData, "ompdesk");
		legacy = path.join(appData, "seucode");
		fs.mkdirSync(path.join(legacy, "Local Storage"), { recursive: true });
		fs.writeFileSync(path.join(legacy, "prefs.json"), '{"lastProject":"/work"}');
		fs.writeFileSync(path.join(legacy, "Local Storage", "leveldb.log"), "state");
	});

	afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

	function shell(): string {
		if (!binary || !path.isAbsolute(binary)) throw new Error("Expected an absolute OMPDESK_TAURI_TEST_BINARY");
		return binary;
	}

	function options(override = "") {
		// An absent app entry stops the real shell just after migration, before it can start Node or any services.
		return {
			cwd: root,
			env: {
				...process.env,
				HOME: root,
				USERPROFILE: root,
				APPDATA: appData,
				LOCALAPPDATA: path.join(root, "Local"),
				TMPDIR: ".", // Resolve socket names inside this child's private cwd, even under a long run-temp path.
				TEMP: root,
				TMP: root,
				OMPDESK_APP_DIR: root,
				OMPDESK_APP_ENTRY: path.join(root, "missing/main/index.js"),
				OMP_GUI_TEST_USER_DATA_DIR: override,
			},
			timeout: 15_000,
			encoding: "utf8" as const,
		};
	}

	function launch(args: string[] = [], override = "", selected = profile): Record<string, unknown>[] {
		const run = spawnSync(shell(), args, options(override));
		if (run.error) throw run.error;
		expect(run.status, run.stderr).toBe(1);
		const lines = fs.readFileSync(path.join(selected, "tauri-shell.jsonl"), "utf8").trim().split("\n");
		return lines.map(line => JSON.parse(line) as Record<string, unknown>);
	}

	it.each([false, true])("moves seucode before the first log (destination precreated: %s)", precreated => {
		if (precreated) fs.mkdirSync(profile);
		const log = launch();
		expect(log).toContainEqual(expect.objectContaining({ event: "shell.started" }));
		expect(log).toContainEqual(
			expect.objectContaining({ event: "user-data-migration", message: "Legacy profile moved into userData" }),
		);
		expect(fs.readFileSync(path.join(profile, "prefs.json"), "utf8")).toBe('{"lastProject":"/work"}');
		expect(fs.readFileSync(path.join(profile, "Local Storage", "leveldb.log"), "utf8")).toBe("state");
		expect(fs.existsSync(legacy)).toBe(false);
	});

	it("never overwrites a used profile", () => {
		fs.mkdirSync(profile);
		fs.writeFileSync(path.join(profile, "prefs.json"), "{}");
		expect(launch().map(line => line.event)).not.toContain("user-data-migration");
		expect(fs.readFileSync(path.join(profile, "prefs.json"), "utf8")).toBe("{}");
		expect(fs.existsSync(path.join(legacy, "prefs.json"))).toBe(true);
	});

	it.each(["switch", "separate switch", "environment"])("skips even an explicit default path (%s)", kind => {
		const args =
			kind === "switch"
				? [`--user-data-dir=${profile}`]
				: kind === "separate switch"
					? ["--user-data-dir", profile]
					: [];
		const log = launch(args, kind === "environment" ? profile : path.join(root, "other"));
		expect(log.map(line => line.event)).not.toContain("user-data-migration");
		expect(fs.existsSync(path.join(profile, "prefs.json"))).toBe(false);
		expect(fs.existsSync(path.join(legacy, "prefs.json"))).toBe(true);
	});

	it("never migrates the sibling of an overridden profile", () => {
		const custom = path.join(appData, "custom");
		launch([], custom, custom);
		expect(fs.existsSync(path.join(legacy, "prefs.json"))).toBe(true);
		expect(fs.existsSync(path.join(custom, "prefs.json"))).toBe(false);
		expect(fs.existsSync(profile)).toBe(false);
	});

	it("does not touch the profile before the first instance acknowledges the handover", () => {
		const hash = createHash("sha256").update(profile.toLowerCase()).digest("hex").slice(0, 16);
		const name = process.platform === "win32" ? `\\\\.\\pipe\\ompdesk-shell-${hash}` : `ompdesk-${hash}-shell.sock`;
		// The fixture listener runs in the same private cwd as the shell, so neither needs a short path in /tmp.
		const primary = String.raw`
			const [name, shell, profile, prefs] = process.argv.slice(1);
			const { existsSync } = require("node:fs");
			const server = require("node:net").createServer(socket => {
				let request = "";
				socket.setEncoding("utf8").on("data", chunk => {
					request += chunk;
					if (!request.endsWith("\n")) return;
					console.log(!existsSync(profile) && existsSync(prefs));
					socket.end("ok\n");
				});
			});
			server.listen(name, () => {
				require("node:child_process").execFile(shell, [], { timeout: 10000 }, error => {
					if (error) { console.error(error); process.exitCode = 1; }
					server.close();
				});
			});`;
		const run = spawnSync(
			process.execPath,
			["-e", primary, name, shell(), profile, path.join(legacy, "prefs.json")],
			options(),
		);
		if (run.error) throw run.error;
		expect(run.status, run.stderr).toBe(0);
		expect(run.stdout.trim()).toBe("true");
		expect(fs.existsSync(path.join(legacy, "prefs.json"))).toBe(true);
		expect(fs.readFileSync(path.join(profile, "tauri-shell.jsonl"), "utf8")).toContain('"event":"shell.handedOver"');
	});
});
