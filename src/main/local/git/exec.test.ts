import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetLoginShellEnvCache } from "../../shell-env";
import { repoRoot } from "./changes";
import { developerGit, ghText, gitRunner, resolveBin } from "./exec";

const made: string[] = [];
const savedEnv = { PATH: process.env.PATH, SHELL: process.env.SHELL };
afterEach(async () => {
	delete process.env.DEVELOPER_DIR;
	delete process.env.OMP_GUI_TEST_BREW_DIRS;
	process.env.PATH = savedEnv.PATH;
	process.env.SHELL = savedEnv.SHELL;
	resetLoginShellEnvCache();
	await Promise.all(made.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	made.push(dir);
	return dir;
}

/** A developer dir whose git answers a root lookup even outside a repository. */
async function fakeDeveloperDir(): Promise<string> {
	const dir = await tempDir("omp-developer-dir-");
	await fs.mkdir(path.join(dir, "usr", "bin"), { recursive: true });
	await fs.writeFile(path.join(dir, "usr", "bin", "git"), "#!/bin/sh\npwd -P\n", { mode: 0o755 });
	return dir;
}

describe.skipIf(process.platform === "win32")("resolveBin", () => {
	it("finds a gh that lands on PATH after an earlier lookup missed it (setup installed it while the app ran)", async () => {
		const before = await tempDir("omp-path-before-");
		const managed = await tempDir("omp-path-managed-");
		// A login shell whose PATH holds no gh, so the user's own gh never answers. No system dir is on it either:
		// a runner's /usr/bin/gh (GitHub's Linux images ship one) would answer before setup does. `env` is the
		// one system binary the probe needs.
		await fs.symlink("/usr/bin/env", path.join(before, "env"));
		const shell = path.join(before, "fake-shell");
		await fs.writeFile(shell, `#!/bin/sh\nexec /usr/bin/env -i PATH=${before} /bin/sh -c "$2"\n`, { mode: 0o755 });
		process.env.SHELL = shell;
		// Not the developer's own Homebrew: a brew-installed gh would answer before setup does.
		process.env.OMP_GUI_TEST_BREW_DIRS = "";
		process.env.PATH = before;
		resetLoginShellEnvCache();
		expect(await resolveBin("gh")).toBeNull();

		// What setup does after an install: the gh lands in the managed tools dir, and refreshPath
		// appends that dir to this process's PATH and drops the login-shell probe.
		await fs.writeFile(path.join(managed, "gh"), "#!/bin/sh\necho gh\n", { mode: 0o755 });
		process.env.PATH = `${process.env.PATH}:${managed}`;
		resetLoginShellEnvCache();
		expect(await resolveBin("gh")).toBe(path.join(managed, "gh"));
	});
});

describe("core spawn failures", () => {
	it("names a working folder that does not exist instead of the program's ENOENT", async () => {
		const gone = path.join(await tempDir("omp-exec-cwd-"), "gone");
		await expect(ghText(gone, process.execPath, ["--version"])).rejects.toMatchObject({
			code: "spawn_failed",
			message: `working folder ${gone} does not exist`,
		});
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"keeps the spawn's own error for a working folder it may not enter, and still rejects",
		async () => {
			const locked = path.join(await tempDir("omp-exec-cwd-"), "locked");
			await fs.mkdir(path.join(locked, "inner"), { recursive: true });
			await fs.chmod(locked, 0o000);
			try {
				await expect(ghText(path.join(locked, "inner"), process.execPath, ["--version"])).rejects.toMatchObject({
					code: "spawn_failed",
					message: `spawn ${process.execPath} EACCES`,
				});
			} finally {
				await fs.chmod(locked, 0o700);
			}
		},
	);
});

describe("the git GUI git calls run", () => {
	it("names the developer dir's git, and nothing for a dir without one", async () => {
		const dir = await fakeDeveloperDir();
		expect(developerGit(`${dir}\n`)).toBe(path.join(dir, "usr", "bin", "git"));
		expect(developerGit(path.join(dir, "usr"))).toBeNull();
		expect(developerGit("")).toBeNull();
		expect(developerGit(null)).toBeNull();
	});

	it.skipIf(process.platform !== "darwin")(
		"runs the developer git instead of macOS's /usr/bin/git trampoline",
		async ctx => {
			if ((await resolveBin("git")) !== "/usr/bin/git") ctx.skip();
			const dir = await fakeDeveloperDir();
			process.env.DEVELOPER_DIR = dir;
			expect((await gitRunner()).bin).toBe(path.join(dir, "usr", "bin", "git"));
			const cwd = await tempDir("omp-git-cwd-");
			expect(await repoRoot(cwd)).toBe(await fs.realpath(cwd));
		},
	);
});
