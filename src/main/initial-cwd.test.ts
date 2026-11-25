/**
 * Contracts for the directory a window starts in when the user named none. The
 * failure modes: a Finder-launched app whose process cwd is "/" opens a session
 * at the volume root, and a remembered project that has since been deleted
 * becomes a window that cannot cd anywhere.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { stopCore } from "./core/process";
import { defaultWorkspace } from "./default-workspace";
import { startupCwd } from "./initial-cwd";

let dir: string;

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-initial-cwd-"));
});

afterEach(() => vi.unstubAllEnvs());

afterAll(async () => {
	await stopCore();
	await fs.rm(dir, { recursive: true, force: true });
});

describe("startup cwd", () => {
	it("skips the Finder root and falls back to home without a project", async () => {
		expect(await startupCwd(dir, [], "/", "home")).toEqual({ cwd: dir, explicit: false });
		expect(await startupCwd(null, [], "/", "home")).toEqual({ cwd: "home", explicit: false });
	});

	it("drops a deleted project or a file but prefers an existing project over the process cwd", async () => {
		const recent = path.join(dir, "recent");
		const file = path.join(dir, "file");
		await fs.mkdir(recent);
		await fs.writeFile(file, "");
		for (const project of [undefined, path.join(dir, "gone"), file]) {
			expect(await startupCwd(project, [], dir)).toEqual({ cwd: dir, explicit: false });
		}
		expect(await startupCwd(recent, [], dir)).toEqual({ cwd: recent, explicit: false });
	});

	it("preserves explicit argv spelling and only checks the first non-flag argument", async () => {
		const file = "explicit-file";
		await fs.writeFile(path.join(dir, file), "");
		expect(await startupCwd(undefined, ["--flag", file], dir)).toEqual({ cwd: file, explicit: true });
		expect(await startupCwd(undefined, ["missing", file], dir)).toEqual({ cwd: dir, explicit: false });
	});
});

describe("default workspace", () => {
	it("creates missing parents beside the profile and recreates the folder when needed", async () => {
		const profile = path.join(dir, "nested", "profile");
		const work = path.join(profile, "work");
		vi.stubEnv("PI_CODING_AGENT_DIR", path.join(profile, "agent"));
		expect(await defaultWorkspace(false)).toBe(work);
		await expect(fs.stat(profile)).rejects.toHaveProperty("code", "ENOENT");
		expect(await defaultWorkspace()).toBe(work);
		expect((await fs.stat(work)).isDirectory()).toBe(true);
		expect(await defaultWorkspace()).toBe(work);
		await fs.rmdir(work);
		expect(await defaultWorkspace()).toBe(work);
		expect((await fs.stat(work)).isDirectory()).toBe(true);
	});

	it("rejects a path occupied by a file without overwriting it", async () => {
		const work = path.join(dir, "work");
		vi.stubEnv("PI_CODING_AGENT_DIR", path.join(dir, "agent"));
		await fs.writeFile(work, "keep");
		await expect(defaultWorkspace()).rejects.toThrow("mkdir");
		expect(await fs.readFile(work, "utf8")).toBe("keep");
	});
});
