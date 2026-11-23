/**
 * Which owner a vendor CLI's resolved executable belongs to (brew formula/cask, bun/npm global, the tool's own
 * updater, winget, machine setup's managed dir) and which copies OMPdesk leaves alone (system, bundled in another
 * app such as a Codex inside ChatGPT.app, admin-owned), plus the real-filesystem detection around it.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { CLI_TOOLS } from "../../shared/cli-update";
import { relevantTools } from "./catalog";
import { detectCliTool, findBrew, ghCopilotVersion, type InstallContext } from "./detect";

describe("relevantTools", () => {
	it("maps each connected provider to its vendor CLI and always lists machine setup's tools", () => {
		expect([...relevantTools([], CLI_TOOLS).keys()]).toEqual(["gh", "node", "agent-desktop"]);
		expect([...relevantTools(["anthropic"], CLI_TOOLS).keys()]).toEqual(["claude", "gh", "node", "agent-desktop"]);
		expect(relevantTools(["openai-codex", "openai", "cursor"], CLI_TOOLS).get("codex")).toEqual([
			"openai-codex",
			"openai",
		]);
		expect([...relevantTools(["google-gemini-cli"], CLI_TOOLS).keys()]).toContain("gemini");
		expect([...relevantTools(["cursor"], CLI_TOOLS).keys()]).toContain("cursor-agent");
		expect([...relevantTools(["github-copilot"], CLI_TOOLS).keys()]).toEqual([
			"copilot",
			"gh",
			"gh-copilot",
			"node",
			"agent-desktop",
		]);
		// A provider with no vendor CLI adds nothing.
		expect([...relevantTools(["openrouter"], CLI_TOOLS).keys()]).toEqual(["gh", "node", "agent-desktop"]);
	});
});

describe("ghCopilotVersion", () => {
	it("reads the gh-copilot extension's version, and says absent when gh lists none", () => {
		expect(ghCopilotVersion("gh copilot\tgithub/gh-copilot\tv1.0.5\n")).toBe("1.0.5");
		expect(ghCopilotVersion("gh dash\tdlvhdr/gh-dash\tv4.1.0\n")).toBeUndefined();
		expect(ghCopilotVersion("")).toBeUndefined();
	});
});

// What npm's cmd-shim writes for `npm install -g @openai/codex` on Windows (a JS bin with a node shebang).
const NPM_CMD_SHIM = [
	"@ECHO off",
	"GOTO start",
	":find_dp0",
	"SET dp0=%~dp0",
	"EXIT /b",
	":start",
	"SETLOCAL",
	"CALL :find_dp0",
	"",
	'IF EXIST "%dp0%\\node.exe" (',
	'  SET "_prog=%dp0%\\node.exe"',
	") ELSE (",
	'  SET "_prog=node"',
	")",
	"",
	'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
	"",
].join("\r\n");

/** A `.bunx` as bun encodes one (BinLinkingShim.zig): the target, `"`, a 0 char, shebang data, the flags. */
function bunx(target: string): Buffer {
	const launcher = "node ";
	const flags = Buffer.alloc(2);
	flags.writeUInt16LE(0b111 | (5478 << 3));
	const lengths = Buffer.alloc(8);
	lengths.writeUInt32LE(target.length * 2, 0);
	lengths.writeUInt32LE(launcher.length * 2, 4);
	return Buffer.concat([Buffer.from(`${target}"\0${launcher}`, "utf16le"), lengths, flags]);
}

const made: string[] = [];
// Not the developer's own Homebrew: its claude or gh would answer for a PATH that holds none.
process.env.OMP_GUI_TEST_BREW_DIRS = "";
afterAll(() => {
	delete process.env.OMP_GUI_TEST_BREW_DIRS;
});
afterEach(async () => {
	for (const dir of made.splice(0)) {
		await fs.chmod(dir, 0o755).catch(() => undefined);
		await fs.rm(dir, { recursive: true, force: true });
	}
});

async function sandbox(): Promise<{ root: string; bin: string }> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-cli-detect-")));
	made.push(root);
	const bin = path.join(root, "bin");
	await fs.mkdir(bin);
	return { root, bin };
}

async function script(file: string, body = "echo fake\n"): Promise<string> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, `#!/bin/sh\n${body}`, { mode: 0o755 });
	return file;
}

describe.skipIf(process.platform === "win32")("detectCliTool", () => {
	const never = async () => {
		throw new Error("the version comes from the package manifest");
	};

	it("finds nothing for a tool that is not installed (a vendor CLI is never installed here)", async () => {
		const { root, bin } = await sandbox();
		const ctx: InstallContext = { platform: "darwin", toolsDir: path.join(root, "tools"), brew: null };
		expect(await detectCliTool("claude", { pathEnv: bin, env: {}, ctx })).toBeNull();
	});

	it("follows the symlink to a Homebrew keg and reads its version from the tool", async () => {
		const { root, bin } = await sandbox();
		const prefix = path.join(root, "homebrew");
		const real = await script(path.join(prefix, "Cellar", "gh", "2.96.0", "bin", "gh"));
		await fs.symlink(real, path.join(bin, "gh"));
		const brew = await script(path.join(prefix, "bin", "brew"));
		const ctx: InstallContext = { platform: "darwin", toolsDir: path.join(root, "tools"), brew };
		const detection = await detectCliTool("gh", {
			pathEnv: bin,
			env: {},
			ctx,
			probe: async (_bin, args) => {
				expect(args).toEqual(["--version"]);
				return "gh version 2.96.0 (2026-01-01)\n";
			},
		});
		expect(detection).toMatchObject({
			id: "gh",
			path: path.join(bin, "gh"),
			real,
			installed: "2.96.0",
			skip: null,
			owner: { method: "brew", name: "gh", brew },
		});
	});

	it("reads an npm global package's version from its manifest and names its prefix", async () => {
		const { root, bin } = await sandbox();
		const prefix = path.join(root, "node-prefix");
		const pkg = path.join(prefix, "lib", "node_modules", "@openai", "codex");
		const real = await script(path.join(pkg, "bin", "codex.js"));
		await fs.writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.50.1" }));
		await fs.symlink(real, path.join(bin, "codex"));
		const ctx: InstallContext = { platform: "darwin", toolsDir: path.join(root, "tools"), brew: null };
		const detection = await detectCliTool("codex", { pathEnv: bin, env: {}, ctx, probe: never });
		expect(detection).toMatchObject({
			installed: "0.50.1",
			skip: null,
			owner: { method: "npm", name: "@openai/codex", prefix, root: pkg },
		});
	});

	it("skips an npm prefix only an administrator can write, and never asks for admin rights", async () => {
		const { root, bin } = await sandbox();
		const prefix = path.join(root, "locked-prefix");
		const modules = path.join(prefix, "lib", "node_modules");
		const pkg = path.join(modules, "@openai", "codex");
		const real = await script(path.join(pkg, "bin", "codex.js"));
		await fs.writeFile(path.join(pkg, "package.json"), JSON.stringify({ version: "0.50.1" }));
		await fs.symlink(real, path.join(bin, "codex"));
		await fs.chmod(path.join(modules, "@openai"), 0o555);
		made.unshift(path.join(modules, "@openai"));
		const ctx: InstallContext = { platform: "darwin", toolsDir: path.join(root, "tools"), brew: null };
		const detection = await detectCliTool("codex", { pathEnv: bin, env: {}, ctx, probe: never });
		expect(detection).toMatchObject({ owner: null, skip: "not-writable", installed: "0.50.1" });
	});

	it("skips a Codex shipped inside another app's bundle but still reports its version", async () => {
		const { root, bin } = await sandbox();
		const real = await script(path.join(root, "Applications", "ChatGPT.app", "Contents", "Resources", "codex"));
		await fs.symlink(real, path.join(bin, "codex"));
		const ctx: InstallContext = { platform: "darwin", toolsDir: path.join(root, "tools"), brew: null };
		const detection = await detectCliTool("codex", {
			pathEnv: bin,
			env: {},
			ctx,
			probe: async () => "codex-cli 0.46.0\n",
		});
		expect(detection).toMatchObject({ owner: null, skip: "bundled", installed: "0.46.0" });
	});

	it("lists Node only as the copy in the managed tools dir", async () => {
		const { root, bin } = await sandbox();
		const tools = path.join(root, "tools");
		await fs.symlink(await script(path.join(root, "elsewhere", "node")), path.join(bin, "node"));
		const ctx: InstallContext = { platform: "darwin", toolsDir: tools, brew: null };
		expect(await detectCliTool("node", { pathEnv: bin, env: {}, ctx })).toBeNull();

		const managed = await script(path.join(tools, "node", "bin", "node"));
		const detection = await detectCliTool("node", {
			pathEnv: path.dirname(managed),
			env: {},
			ctx,
			probe: async () => "v24.11.0\n",
		});
		expect(detection).toMatchObject({ owner: { method: "managed", item: "node" }, installed: "24.11.0", skip: null });
	});

	it("lists agent-desktop as the managed copy even when the user's own sits earlier on PATH", async () => {
		const { root, bin } = await sandbox();
		const tools = path.join(root, "tools");
		const mine = await script(path.join(root, "npm-bin", "agent-desktop"));
		await fs.symlink(mine, path.join(bin, "agent-desktop"));
		const ctx: InstallContext = { platform: "darwin", toolsDir: tools, brew: null };
		// Only the user's copy: nothing of OMPdesk's to list.
		expect(await detectCliTool("agent-desktop", { pathEnv: bin, env: {}, ctx })).toBeNull();

		const managed = await script(path.join(tools, "agent-desktop", "agent-desktop"));
		const detection = await detectCliTool("agent-desktop", {
			pathEnv: bin,
			env: {},
			ctx,
			probe: async () => "agent-desktop 1.2.0\n",
		});
		expect(detection).toMatchObject({
			path: managed,
			owner: { method: "managed", item: "agent-desktop" },
			installed: "1.2.0",
			skip: null,
		});
	});

	it("lists the app's bundled agent-desktop for an update into the managed tools dir until a managed copy is newer", async () => {
		const { root, bin } = await sandbox();
		const tools = path.join(root, "tools");
		const bundle = path.join(root, "bundle");
		const bundled = await script(path.join(bundle, "agent-desktop"));
		await fs.writeFile(path.join(bundle, "agent-desktop.build.json"), JSON.stringify({ version: "1.2.0" }));
		const ctx: InstallContext = { platform: "darwin", toolsDir: tools, agentDesktopBundle: bundle, brew: null };
		const owner = { method: "managed", item: "agent-desktop" };
		// No managed copy yet, and its tools dir does not exist: the bundle's version is what the update starts from.
		expect(await detectCliTool("agent-desktop", { pathEnv: bin, env: {}, ctx })).toMatchObject({
			path: bundled,
			owner,
			installed: "1.2.0",
			skip: null,
		});
		const managed = await script(path.join(tools, "agent-desktop", "agent-desktop"));
		const older = await detectCliTool("agent-desktop", { pathEnv: bin, env: {}, ctx, probe: async () => "1.1.0" });
		expect(older).toMatchObject({ path: bundled, owner, installed: "1.2.0" });
		const newer = await detectCliTool("agent-desktop", { pathEnv: bin, env: {}, ctx, probe: async () => "1.3.0" });
		expect(newer).toMatchObject({ path: managed, owner, installed: "1.3.0" });
	});

	it("detects the gh-copilot extension through gh, and nothing when gh lists none", async () => {
		const { root, bin } = await sandbox();
		await fs.symlink(await script(path.join(root, "gh-real", "gh")), path.join(bin, "gh"));
		const ctx: InstallContext = { platform: "darwin", toolsDir: path.join(root, "tools"), brew: null };
		const present = await detectCliTool("gh-copilot", {
			pathEnv: bin,
			env: {},
			ctx,
			probe: async (_bin, args) => {
				expect(args).toEqual(["extension", "list"]);
				return "gh copilot\tgithub/gh-copilot\tv1.0.5\n";
			},
		});
		expect(present).toMatchObject({ id: "gh-copilot", installed: "1.0.5", owner: { method: "self" }, skip: null });
		expect(await detectCliTool("gh-copilot", { pathEnv: bin, env: {}, ctx, probe: async () => "" })).toBeNull();
	});
});

describe.runIf(process.platform === "win32")("detectCliTool on Windows", () => {
	it("follows an npm global's .cmd shim to its package, and never takes the bare POSIX script beside it", async () => {
		const { root, bin } = await sandbox();
		const pkg = path.join(bin, "node_modules", "@openai", "codex");
		await fs.mkdir(path.join(pkg, "bin"), { recursive: true });
		await fs.writeFile(path.join(pkg, "bin", "codex.js"), "");
		await fs.writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.50.1" }));
		await fs.writeFile(path.join(bin, "codex"), "#!/bin/sh\n");
		const ctx: InstallContext = { platform: "win32", toolsDir: path.join(root, "tools"), brew: null };
		const never = async () => {
			throw new Error("the version comes from the package manifest");
		};
		expect(await detectCliTool("codex", { pathEnv: bin, env: {}, ctx, probe: never })).toBeNull();
		await fs.writeFile(path.join(bin, "codex.cmd"), NPM_CMD_SHIM);
		expect(await detectCliTool("codex", { pathEnv: bin, env: {}, ctx, probe: never })).toMatchObject({
			path: path.join(bin, "codex.cmd"),
			real: path.join(pkg, "bin", "codex.js"),
			installed: "0.50.1",
			skip: null,
			owner: { method: "npm", name: "@openai/codex", prefix: bin, root: pkg },
		});
	});

	it("follows a Bun global's shim .exe and its .bunx to the package, so Bun's install owns it", async () => {
		const { root } = await sandbox();
		const bunHome = path.join(root, ".bun");
		const bin = path.join(bunHome, "bin");
		const pkg = path.join(bunHome, "install", "global", "node_modules", "@openai", "codex");
		await fs.mkdir(path.join(pkg, "bin"), { recursive: true });
		await fs.mkdir(bin, { recursive: true });
		await fs.writeFile(path.join(pkg, "bin", "codex.js"), "");
		await fs.writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.51.0" }));
		await fs.writeFile(path.join(bin, "codex.exe"), "MZ");
		await fs.writeFile(
			path.join(bin, "codex.bunx"),
			bunx("install\\global\\node_modules\\@openai\\codex\\bin\\codex.js"),
		);
		const ctx: InstallContext = { platform: "win32", toolsDir: path.join(root, "tools"), brew: null };
		const never = async () => {
			throw new Error("the version comes from the package manifest");
		};
		expect(await detectCliTool("codex", { pathEnv: bin, env: {}, ctx, probe: never })).toMatchObject({
			path: path.join(bin, "codex.exe"),
			real: path.join(pkg, "bin", "codex.js"),
			installed: "0.51.0",
			skip: null,
			owner: { method: "bun", name: "@openai/codex", bunRoot: bunHome, root: pkg },
		});
	});
});

describe("findBrew", () => {
	it("finds brew on PATH, never on Windows", async () => {
		const { bin } = await sandbox();
		const brew = await script(path.join(bin, "brew"));
		process.env.OMP_GUI_TEST_BREW_DIRS = "";
		try {
			expect(findBrew(bin, "darwin")).toBe(brew);
			expect(findBrew("", "darwin")).toBeNull();
			expect(findBrew(bin, "win32")).toBeNull();
		} finally {
			delete process.env.OMP_GUI_TEST_BREW_DIRS;
		}
	});
});
