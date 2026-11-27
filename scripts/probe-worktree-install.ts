import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { configureNativeBin, nativeBinPath } from "../src/main/native-bin";
import { superviseWorktreeHook } from "../src/main/setup/supervisor";
import { dropGitSelectors } from "../src/shared/git-env";

// Exercise the public setup hook with a one-line writer instead of installing any packages.
const source = resolve(import.meta.dir, "..");
const cli = process.argv[2] ?? nativeBinPath("ompdesk");
const core = process.argv[3] ?? nativeBinPath("ompdesk-core");
const root = mkdtempSync(join(tmpdir(), "setup-admission-"));
const marker = join(root, "writer");
const dir = join(root, "ompdesk-bin");
const hook = `.ompdesk/worktree-setup${process.platform === "win32" ? ".cmd" : ""}`;
try {
	mkdirSync(dir);
	mkdirSync(join(root, ".ompdesk"));
	mkdirSync(join(root, "scripts"));
	configureNativeBin({ packaged: true, resourcesPath: root });
	copyFileSync(core, nativeBinPath("ompdesk-core"));
	copyFileSync(join(source, hook), join(root, hook));
	const installer = pathToFileURL(join(source, "scripts/worktree-install.ts")).href;
	writeFileSync(join(root, "scripts/worktree-install.ts"), `import ${JSON.stringify(installer)};`);
	writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { "worktree:install": "bun marker.ts" } }));
	writeFileSync(
		join(root, "marker.ts"),
		'import {appendFileSync} from "node:fs"; appendFileSync("writer", "one\\n");',
	);
	dropGitSelectors();
	execFileSync("git", ["init", "-q"], { cwd: root });
	Object.assign(process.env, {
		GITHUB_ACTIONS: "true",
		OMPDESK_SETUP_CLI: process.execPath,
		OMPDESK_HEAVY_HELD: String(process.pid),
		OMPDESK_WRITE_BYTES: "not the install's declaration",
		OMPDESK_HEAVY_DIR: join(root, "package.json"),
		BUN_INSTALL_CACHE_DIR: join(root, "bun-cache"),
		electron_config_cache: join(root, "electron-cache"),
	});
	const setup = () =>
		superviseWorktreeHook(
			"setup",
			{ primary: root, worktree: root, cwd: root, timeoutMs: 15000 },
			{ script: join(root, hook), logPath: join(root, "ompdesk-worktree-setup.log") },
		);
	const missing = await setup();
	assert.equal(missing.ok, false);
	assert.match(missing.outputTail, /ENOENT/);
	assert.equal(existsSync(marker), false);
	copyFileSync(cli, nativeBinPath("ompdesk"));
	const refused = await setup();
	assert.equal(refused.ok, false);
	assert.match(refused.outputTail, /cannot take a heavy slot/);
	assert.equal(existsSync(marker), false);
	process.env.OMPDESK_HEAVY_DIR = join(root, "pool");
	const admitted = await setup();
	assert.equal(admitted.ok, true, admitted.outputTail);
	assert.equal(readFileSync(marker, "utf8"), "one\n");
	delete process.env.OMPDESK_HOOK;
	delete process.env.OMPDESK_WRITE_BYTES;
	execFileSync(process.execPath, [join(source, "scripts/worktree-install.ts")], { cwd: root, env: process.env });
	assert.equal(readFileSync(marker, "utf8"), "one\none\n");
	console.log("Managed setup: missing CLI 0 writes, refusal 0, admitted 1. Standalone: 1 write.");
} finally {
	rmSync(root, { recursive: true, force: true });
}
