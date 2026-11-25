import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitSync, initRepo } from "../local/git/test-repos";
import { lastActivity, readWorktreeFiles } from "./worktree-facts";

const KEYS = ["HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "PI_CODING_AGENT_DIR"];
const kept: Record<string, string | undefined> = {};
let root = "";

beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-folder-")));
	for (const key of KEYS) kept[key] = process.env[key];
	const home = path.join(root, "home");
	// The temp folder inside the home folder, as on Windows.
	const temp = path.join(home, "Temp");
	await fs.mkdir(temp, { recursive: true });
	Object.assign(process.env, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: path.join(root, "agent"),
	});
});

afterEach(async () => {
	for (const key of KEYS) {
		if (kept[key] === undefined) delete process.env[key];
		else process.env[key] = kept[key];
	}
	await fs.rm(root, { recursive: true, force: true });
});

const FUTURE_SECONDS = Math.floor(Date.now() / 1000) + 86_400;

async function expectSessionActivity(cwd: string, name: string, temp = path.join(root, "home", "Temp")): Promise<void> {
	await initRepo(cwd);
	Object.assign(process.env, { TMPDIR: temp, TEMP: temp, TMP: temp });
	const files = await readWorktreeFiles(cwd);
	for (const [folder, seconds] of [
		[name, FUTURE_SECONDS],
		["unrelated", FUTURE_SECONDS + 1],
	] as const) {
		const dir = path.join(root, "agent", "sessions", folder);
		await fs.mkdir(dir, { recursive: true });
		const session = path.join(dir, "session.jsonl");
		await fs.writeFile(session, "");
		await fs.utimes(session, seconds, seconds);
	}
	expect(await lastActivity(cwd, files)).toBe(FUTURE_SECONDS * 1000);
}

describe("lastActivity reads the sessions stock names for this worktree", () => {
	it.each([
		["home", "-"],
		["home/.omp/wt/gui-a-abc1234", "-.omp-wt-gui-a-abc1234"],
		["home/Temp", "-tmp"],
		["home/Temp/ompdesk-main/src", "-tmp-ompdesk-main-src"],
		["home/Temp/..notes/src", "-Temp-..notes-src"],
	])("%s reads %s", async (folder, name) => {
		await expectSessionActivity(path.join(root, folder), name);
	});

	it.each([
		["external-wt/a", "external-wt-a"],
		["home/..notes/repo", "home-..notes-repo"],
		["home-sibling/repo", "home-sibling-repo"],
	])("uses the full path for %s", async (folder, suffix) => {
		const prefix = root.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
		await expectSessionActivity(path.join(root, folder), `--${prefix}-${suffix}--`);
	});

	it.each([
		["home/Temp/temp-repo", "-tmp-temp-repo"],
		["home/home-repo", "-home-repo"],
	])("reads %s through linked home and temp roots", async (folder, name) => {
		const homeLink = path.join(root, "home-link");
		const tempLink = path.join(root, "temp-link");
		const type = process.platform === "win32" ? "junction" : "dir";
		await fs.symlink(path.join(root, "home"), homeLink, type);
		await fs.symlink(path.join(root, "home", "Temp"), tempLink, type);
		Object.assign(process.env, { HOME: homeLink, USERPROFILE: homeLink });
		await expectSessionActivity(path.join(root, folder), name, tempLink);
	});

	it("resolves parent steps when deciding whether temp or home contains the path", async () => {
		const cwd = `${path.join(root, "home", "Temp")}${path.sep}..${path.sep}repo`;
		await expectSessionActivity(cwd, "-repo");
	});

	it("normalizes repeated separators and current-directory steps in a home-relative path", async () => {
		const cwd = `${path.join(root, "home")}/nested//./repo`;
		await expectSessionActivity(cwd, "-nested-repo");
	});

	it.skipIf(process.platform !== "win32")("folds drive and parent case but keeps the child's spelling", async () => {
		const home = path
			.join(root, "home")
			.toUpperCase()
			.replace(/^[A-Z]:/, drive => drive.toLowerCase());
		await expectSessionActivity(path.join(home, "tEMP", "MixedCase"), "-tmp-MixedCase");
	});

	it.skipIf(process.platform === "win32")("dashes a literal backslash and colon in a POSIX filename", async () => {
		await expectSessionActivity(path.join(root, "home", "a\\b:c"), "-a-b-c");
	});
});

it("counts tracked and untracked files and walks hand-made ignored trees, but skips regenerable output", async () => {
	const cwd = path.join(root, "repo");
	await initRepo(cwd);
	await fs.writeFile(path.join(cwd, ".gitignore"), "/private/\n/cache/\n");
	const paths = ["tracked", "untracked", "private/nested/note", "cache/output"];
	for (const file of paths) {
		await fs.mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
		await fs.writeFile(path.join(cwd, file), "");
	}
	await fs.writeFile(path.join(cwd, "cache", "CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55\n");
	gitSync(cwd, "add", "tracked", ".gitignore");
	const files = await readWorktreeFiles(cwd);
	for (const [index, file] of paths.entries()) {
		await fs.utimes(path.join(cwd, file), FUTURE_SECONDS + index, FUTURE_SECONDS + index);
		expect(await lastActivity(cwd, files)).toBe((FUTURE_SECONDS + Math.min(index, 2)) * 1000);
	}
});
