import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { RM_TEMP } from "../test-fake-omp";
import {
	findGitBash,
	managedAgentDesktop,
	managedGitRoot,
	managedToolEnv,
	managedToolsDir,
	mergePathLists,
} from "./paths";

const bun = spawnSync("bun", ["-e", "console.log(process.execPath)"], { encoding: "utf8" }).stdout?.trim() ?? "";

describe("PATH refresh", () => {
	it("reads machine then user, binds names in the current environment and reapplies managed tools", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ompdesk-reg-path-"));
		try {
			const bin = join(dir, "fake registry");
			const tools = join(dir, "tools");
			const managed = join(tools, "git", "cmd");
			await mkdir(bin);
			await mkdir(managed, { recursive: true });
			const reg = join(bin, "reg.exe");
			// Homebrew Node resolves libnode relative to its executable; a hardlink relocates it.
			if (process.platform !== "win32") await symlink(process.execPath, reg);
			else await link(process.execPath, reg).catch(() => copyFile(process.execPath, reg));
			await writeFile(
				join(dir, "query"),
				`const [key, flag, value] = process.argv.slice(2);
if (flag !== "/v" || value !== "Path" || process.env.OMPDESK_HUB_TOKEN) process.exit(1);
if (key === ${JSON.stringify("HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment")}) {
	console.log("    Path    REG_SZ    base/;C:\\\\Program Files\\\\Git\\\\cmd;%empty%");
	switch (process.env.REG_RESULT) {
		case "exit": process.exitCode = 1; break;
		case "stdout": process.stdout.write("x".repeat(1024 * 1024 + 1)); break;
		case "stderr": process.stderr.write("x".repeat(1024 * 1024 + 1)); break;
		case "timeout": Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); break;
	}
} else if (key === ${JSON.stringify("HKCU\\Environment")}) {
	console.log("  pAtH\\tREG_EXPAND_SZ\\t   %SETUP_User%\\\\.bun\\\\bin;c:\\\\program files\\\\git\\\\cmd\\\\;%NOPE%\\\\x;  ");
} else process.exit(1);`,
			);
			const script = `import { refreshPath } from ${JSON.stringify(join(__dirname, "paths.ts"))};
import { stopCore } from ${JSON.stringify(join(__dirname, "../core/process.ts"))};
import { renameSync } from "node:fs";
const results = [];
try {
	for (const mode of ["ok", "exit", "stdout", "stderr", "timeout", "suffix", "missing"]) {
		if (mode === "suffix" && process.platform === "win32") {
			renameSync(${JSON.stringify(reg)}, ${JSON.stringify(`${reg}.com`)});
		}
		process.env.PATH = mode === "missing" ? "missing" : ${JSON.stringify(bin)};
		process.env.REG_RESULT = mode;
		process.env.SETUP_USER = "old";
		const pending = refreshPath("win32", ${JSON.stringify(tools)});
		process.env.PATH = "Base;BASE;;";
		process.env.SETUP_USER = "C:\\\\Users\\\\First Last";
		await pending;
		results.push(process.env.PATH);
	}
	console.log(JSON.stringify(results));
} finally { await stopCore(); }`;
			expect(bun).toBeTruthy();
			const result = spawnSync(bun, ["-e", script], {
				cwd: dir,
				encoding: "utf8",
				env: {
					PATH: bin,
					SystemRoot: process.env.SystemRoot,
					HOME: dir,
					USERPROFILE: dir,
					APPDATA: dir,
					LOCALAPPDATA: dir,
					TMP: dir,
					TEMP: dir,
					TMPDIR: dir,
					empty: "",
					NoDefaultCurrentDirectoryInExePath: "1",
				},
				timeout: 30_000,
				windowsHide: true,
			});
			expect(result.status, result.stderr).toBe(0);
			const userOnly = `Base;BASE;C:\\Users\\First Last\\.bun\\bin;c:\\program files\\git\\cmd\\;%NOPE%\\x;${managed}`;
			const both = `Base;BASE;C:\\Program Files\\Git\\cmd;C:\\Users\\First Last\\.bun\\bin;%NOPE%\\x;${managed}`;
			expect(JSON.parse(result.stdout.trim())).toEqual([
				both,
				userOnly,
				userOnly,
				userOnly,
				userOnly,
				both,
				`Base;BASE;${managed}`,
			]);
		} finally {
			await rm(dir, RM_TEMP);
		}
	}, 35_000); // The real core's 10 s deadline ends the stuck reg.exe; Vitest timers cannot advance it.

	it("appends only new entries, comparing case- and slash-insensitively on Windows", () => {
		const base = "C:\\Windows\\System32;C:\\Users\\a\\.bun\\bin\\";
		expect(
			mergePathLists(
				base,
				["c:\\windows\\system32;C:\\Program Files\\Git\\cmd", "C:\\Users\\a\\.bun\\bin"],
				"win32",
				";",
			),
		).toBe("C:\\Windows\\System32;C:\\Users\\a\\.bun\\bin\\;C:\\Program Files\\Git\\cmd");
		expect(mergePathLists("/usr/bin:/Bin", ["/bin", "/usr/bin"], "darwin", ":")).toBe("/usr/bin:/Bin:/bin");
	});
});

it("resolves development and packaged native binaries from Node ESM", () => {
	const moduleUrl = new URL("../native-bin.ts", import.meta.url).href;
	const packaged = join(tmpdir(), "Packaged Resources");
	const script = `import { configureNativeBin, nativeBinPath } from ${JSON.stringify(moduleUrl)};
console.log(nativeBinPath("ompdesk-core"));
configureNativeBin({ packaged: true, resourcesPath: ${JSON.stringify(packaged)} });
console.log(nativeBinPath("ompdesk-core"));`;
	const result = spawnSync("node", ["--experimental-strip-types", "--input-type=module", "-e", script], {
		cwd: tmpdir(),
		encoding: "utf8",
		windowsHide: true,
	});
	expect(result.status, result.stderr).toBe(0);
	const binary = process.platform === "win32" ? "ompdesk-core.exe" : "ompdesk-core";
	expect(result.stdout.trim().split(/\r?\n/)).toEqual([
		join(__dirname, "../../..", "resources", "ompdesk-bin", `${process.platform}-${process.arch}`, binary),
		join(packaged, "ompdesk-bin", binary),
	]);
});

describe("managed tools", () => {
	it("lives under %LOCALAPPDATA%\\ompdesk\\tools on Windows and userData elsewhere", () => {
		expect(managedToolsDir("win32", { LOCALAPPDATA: "L" }, "H", "U")).toBe(join("L", "ompdesk", "tools"));
		expect(managedToolsDir("win32", {}, "H", "U")).toBe(join("H", "AppData", "Local", "ompdesk", "tools"));
		expect(managedToolsDir("darwin", { LOCALAPPDATA: "L" }, "H", "U")).toBe(join("U", "tools"));
	});

	it("appends existing managed bin dirs and points GIT_INSTALL_ROOT at a managed PortableGit", () => {
		const tools = join("T", "tools");
		const git = managedGitRoot(tools);
		const present = new Set([join(git, "cmd"), join(git, "bin", "bash.exe"), join(tools, "node", "bin")]);
		const exists = (file: string) => present.has(file);
		expect(managedToolEnv({ PATH: "A;B" }, tools, "win32", exists)).toEqual({
			PATH: `A;B;${join(git, "cmd")}`,
			GIT_INSTALL_ROOT: git,
		});
		// The user's own GIT_INSTALL_ROOT wins.
		expect(managedToolEnv({ PATH: "", GIT_INSTALL_ROOT: "mine" }, tools, "win32", exists)).not.toHaveProperty(
			"GIT_INSTALL_ROOT",
		);
		// No PortableGit yet: nothing to point at.
		expect(managedToolEnv({ PATH: "" }, tools, "win32", () => false)).toEqual({ PATH: "" });
		expect(managedToolEnv({ PATH: "/usr/bin" }, tools, "darwin", exists)).toEqual({
			PATH: ["/usr/bin", join(tools, "node", "bin")].join(":"),
		});
	});

	it("keeps agent-desktop and its macOS helper in one folder that is on PATH once it exists, on both platforms", () => {
		const tools = join("T", "tools");
		const dir = join(tools, "agent-desktop");
		expect(managedAgentDesktop(tools, "darwin")).toBe(join(dir, "agent-desktop"));
		expect(managedAgentDesktop(tools, "win32")).toBe(join(dir, "agent-desktop.exe"));
		for (const platform of ["darwin", "win32"] as const) {
			const sep = platform === "win32" ? ";" : ":";
			expect(managedToolEnv({ PATH: "A" }, tools, platform, file => file === dir)).toEqual({
				PATH: ["A", dir].join(sep),
			});
			expect(managedToolEnv({ PATH: "A" }, tools, platform, () => false).PATH).toBe("A");
		}
	});
});

describe("findGitBash", () => {
	it("follows stock's Git for Windows roots in order, then a git.exe on PATH with bin\\bash.exe", () => {
		const bash = (root: string) => join(root, "bin", "bash.exe");
		const roots = {
			ProgramFiles: "PF",
			"ProgramFiles(x86)": "PF86",
			LOCALAPPDATA: "LA",
			GIT_INSTALL_ROOT: "GIR",
			SCOOP: "SC",
			USERPROFILE: "UP",
		};
		const only =
			(...files: string[]) =>
			(file: string) =>
				files.includes(file);
		expect(findGitBash(roots, only(bash(join("PF", "Git")), bash("GIR")))).toBe(bash(join("PF", "Git")));
		expect(findGitBash(roots, only(bash(join("LA", "Programs", "Git")), bash("GIR")))).toBe(
			bash(join("LA", "Programs", "Git")),
		);
		expect(findGitBash(roots, only(bash("GIR")))).toBe(bash("GIR"));
		expect(findGitBash(roots, only(bash(join("UP", "scoop", "apps", "git", "current"))))).toBe(
			bash(join("UP", "scoop", "apps", "git", "current")),
		);
		const gitCmd = join("X", "Git", "cmd");
		expect(
			findGitBash(
				{ PATH: `C:\\Windows\\System32;${gitCmd}` },
				only(join(gitCmd, "git.exe"), bash(join("X", "Git"))),
			),
		).toBe(bash(join("X", "Git")));
		// WSL's System32 bash.exe is not Git Bash.
		expect(
			findGitBash({ PATH: "C:\\Windows\\System32" }, only(join("C:\\Windows\\System32", "bash.exe"))),
		).toBeNull();
	});
});

/** Stock omp's shell resolver, when this machine has omp installed (skipped otherwise, e.g. on CI). */
const stockProcmgr = join(
	process.env.HOME ?? process.env.USERPROFILE ?? "",
	".bun",
	"install",
	"global",
	"node_modules",
	"@oh-my-pi",
	"pi-utils",
	"src",
	"procmgr.ts",
);

describe.skipIf(!existsSync(stockProcmgr) || !bun)("stock omp's Windows shell", () => {
	it("is the managed PortableGit's bash.exe for an omp spawned with managedToolEnv", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ompdesk-gitbash-"));
		try {
			const tools = join(dir, "tools");
			const bash = join(managedGitRoot(tools), "bin", "bash.exe");
			await mkdir(dirname(bash), { recursive: true });
			await mkdir(join(managedGitRoot(tools), "cmd"), { recursive: true });
			await writeFile(bash, "");
			// A machine without Git for Windows: no ProgramFiles Git, nothing on PATH.
			const env = { ComSpec: "C:\\Windows\\System32\\cmd.exe", ...managedToolEnv({ PATH: "" }, tools, "win32") };
			const script = `import { resolveWindowsShell } from ${JSON.stringify(stockProcmgr)};\nconsole.log(resolveWindowsShell(JSON.parse(process.env.OMPDESK_ENV)));`;
			const result = spawnSync("bun", ["-e", script], {
				encoding: "utf8",
				env: { ...process.env, OMPDESK_ENV: JSON.stringify(env) },
			});
			expect(result.status).toBe(0);
			expect(result.stdout.trim()).toBe(bash);
			// And with the same layout, OMPdesk's own discovery agrees with stock.
			expect(findGitBash(env)).toBe(bash);
		} finally {
			await rm(dir, RM_TEMP);
		}
	});
});
