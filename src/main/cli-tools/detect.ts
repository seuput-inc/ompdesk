/**
 * Where an installed vendor CLI lives and what owns it. The executable is found along the spawn PATH (the
 * login shell's, like every tool OMPdesk runs) and followed through its symlinks; the resolved path says
 * which package manager put it there — the same idea as `ompUpdateEnv` for omp: update a tool only through
 * the install that the user's own shell runs.
 */
import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import type { CliSkipReason, CliToolId } from "../../shared/cli-update";
import { isNewer } from "../../shared/version";
import { pickAgentDesktop } from "../agent-desktop";
import { extRule } from "../ext-update/core";
import { parseOmpVersion } from "../omp-runtime";
import { managedBinDirs } from "../setup/paths";
import { brewBinDirs } from "../shell-env";
import { findOnPath, launcherNames, needsShell, spawnArgs, spawnCommand } from "../spawn";
import { CLI_TOOL_SPECS } from "./catalog";

export type CliPlatform = "darwin" | "win32";

/** Homebrew's `brew`: on PATH, else at its standard prefixes. Null on Windows and on a Mac without it. */
export function findBrew(pathEnv: string, platform: CliPlatform): string | null {
	return platform === "win32"
		? null
		: findOnPath(
				["brew"],
				pathEnv,
				platform,
				brewBinDirs().map(dir => join(dir, "brew")),
			);
}

/** The package manager or installer that owns the resolved executable. */
export type CliOwner =
	| { method: "brew" | "brew-cask"; name: string; brew: string }
	| { method: "npm"; name: string; prefix: string; root: string }
	| { method: "bun"; name: string; bunRoot: string; root: string }
	| { method: "winget"; id: string }
	| { method: "managed"; item: "gh" | "node" | "agent-desktop" }
	| { method: "self" };

export interface InstallContext {
	platform: CliPlatform;
	/** Machine setup's managed tools dir. */
	toolsDir: string;
	/** The agent-desktop the app ships (src/main/agent-desktop.ts); absent in tests that do not need it. */
	agentDesktopBundle?: string;
	/** Homebrew's `brew`, when this Mac has it. */
	brew: string | null;
}

type InstallSource =
	| { kind: "cli"; spec: { self: boolean; managed?: string; managedOnly?: boolean; winget?: string } }
	| { kind: "ghExtension" | "omp" | "bundle" }
	| { kind: "mcp"; command: string };

export type VenvOwner = { method: "pipx"; name: string; venv: string } | { method: "uv"; name: string; dir: string };

type InstallFacts<T> = ({ owner: T; skip: null } | { owner: null; skip: CliSkipReason }) & {
	launcher: string;
	real: string;
	writable: boolean;
	installed: string | null;
};

type McpFacts = InstallFacts<Exclude<CliOwner, { method: "managed" | "self" }> | VenvOwner> & {
	mcp: { name: string; script: boolean; python: string | null };
};

export function readInstall(
	path: string,
	ctx: InstallContext,
	source: Extract<InstallSource, { kind: "mcp" }>,
): Promise<McpFacts>;
export function readInstall(
	path: string,
	ctx: InstallContext,
	source: Exclude<InstallSource, { kind: "mcp" }>,
): Promise<InstallFacts<CliOwner>>;
export function readInstall(
	path: string,
	{ platform, toolsDir, brew }: InstallContext,
	source: InstallSource,
): Promise<InstallFacts<CliOwner | VenvOwner>> {
	let drives: Record<string, string> | undefined;
	if (process.platform === "win32") {
		for (const input of [path, toolsDir, brew]) {
			if (input && /^[a-z]:(?![\\/])/i.test(input)) {
				const drive = input.slice(0, 2);
				drives ??= {};
				drives[drive] ??= resolve(drive);
			}
		}
	}
	return extRule("ext.binaryFacts", {
		path,
		file: resolve(path),
		cwd: process.cwd(),
		drives,
		ctx: { platform, toolsDir, brew },
		source,
	});
}

export interface CliDetection {
	id: CliToolId;
	/** As found on PATH. */
	path: string;
	/** Symlinks resolved. */
	real: string;
	owner: CliOwner | null;
	skip: CliSkipReason | null;
	installed: string | null;
}

export interface DetectDeps {
	pathEnv: string;
	env: NodeJS.ProcessEnv;
	ctx: InstallContext;
	/** `<bin> <args>` stdout, or throws (test seam). */
	probe?: (bin: string, args: string[]) => Promise<string>;
}

export function probeOutput(
	bin: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	platform: CliPlatform,
): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	execFile(
		spawnCommand(bin, platform),
		spawnArgs(bin, args, platform),
		{ env, shell: needsShell(bin, platform), timeout: 15_000, windowsHide: true },
		(error, stdout, stderr) => (error ? reject(new Error((stderr || error.message).trim())) : resolve(stdout)),
	);
	return promise;
}

/** `gh extension list`: the gh-copilot line's version (`v1.0.5`), or null when the extension is absent. */
export function ghCopilotVersion(list: string): string | null | undefined {
	const line = list.split(/\r?\n/).find(entry => /github\/gh-copilot\b/.test(entry));
	if (!line) return undefined;
	return parseOmpVersion(line);
}

/**
 * Find and classify `id`; null when it is not installed (OMPdesk never installs a vendor CLI). agent-desktop is also
 * installed when only the app's own copy is, or the managed copy is older: it is machine setup's to update, and an
 * update installs the newer release into the managed tools dir, which sessions run from their next start
 * (src/main/agent-desktop.ts `pickAgentDesktop`).
 */
export async function detectCliTool(id: CliToolId, deps: DetectDeps): Promise<CliDetection | null> {
	const found = await detectInstalled(id, deps);
	const { ctx } = deps;
	const bundled =
		id === "agent-desktop" && ctx.agentDesktopBundle
			? await pickAgentDesktop(ctx.platform, ctx.agentDesktopBundle)
			: null;
	if (!bundled || (found?.installed && !isNewer(bundled.version, found.installed))) return found;
	const { writable, owner } = await readInstall(bundled.path, ctx, { kind: "bundle" });
	const skip = writable ? null : "not-writable";
	return {
		id,
		path: bundled.path,
		real: bundled.path,
		owner: skip ? null : owner,
		skip,
		installed: bundled.version,
	};
}

async function detectInstalled(id: CliToolId, deps: DetectDeps): Promise<CliDetection | null> {
	const spec = CLI_TOOL_SPECS[id];
	const { ctx } = deps;
	const win = ctx.platform === "win32";
	// Never the bare name on Windows: npm writes one beside its `.cmd` for POSIX shells, which Windows cannot start.
	const names = launcherNames(spec.bin, ctx.platform);
	// A managed-only tool is the copy in the managed tools dir: looked up there first, so one the user put earlier
	// on PATH (npm, Homebrew) never hides it. Others are found along the spawn PATH.
	const lookupPath = spec.managedOnly
		? [...managedBinDirs(ctx.toolsDir, ctx.platform), deps.pathEnv].join(win ? ";" : ":")
		: deps.pathEnv;
	// Homebrew's prefixes count even when the login shell's PATH omits them (the same lookup `resolveBin` makes).
	const path = findOnPath(
		names,
		lookupPath,
		ctx.platform,
		win ? [] : brewBinDirs().flatMap(dir => names.map(name => join(dir, name))),
	);
	if (!path) return null;
	const {
		real,
		owner,
		skip,
		writable,
		installed: fromPackage,
	} = await readInstall(
		path,
		ctx,
		id === "gh-copilot"
			? { kind: "ghExtension" }
			: {
					kind: "cli",
					spec: { self: !!spec.self, managed: spec.managed, managedOnly: spec.managedOnly, winget: spec.winget },
				},
	);
	const probe = deps.probe ?? ((bin: string, args: string[]) => probeOutput(bin, args, deps.env, ctx.platform));
	if (id === "gh-copilot") {
		// The extension lives in gh's own data dir, which is the user's; gh itself upgrades it.
		const version = ghCopilotVersion(await probe(path, ["extension", "list"]).catch(() => ""));
		if (version === undefined) return null;
		return { id, path, real, owner, skip, installed: version };
	}
	if (skip === "unknown-install" && spec.managedOnly) return null;
	const refused = owner && !writable ? "not-writable" : skip;
	const installed = fromPackage ?? (await probe(path, ["--version"]).then(parseOmpVersion, () => null));
	return { id, path, real, owner: refused ? null : owner, skip: refused, installed };
}
