/** Resolve an MCP command on the spawn PATH. The core reads its launcher and package ownership.
 * Only pip's console-script lookup needs a running interpreter; no server or installer is started.
 */
import { accessSync, constants, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionSkipReason } from "../../shared/extension-update";
import { type InstallContext, readInstall, type VenvOwner } from "../cli-tools/detect";
import type { PackageOwner } from "../cli-tools/plans";
import { brewBinDirs } from "../shell-env";
import { findOnPath, launcherNames } from "../spawn";

export type McpOwner = PackageOwner | VenvOwner | { method: "pip"; name: string; python: string };

export type McpSkip = Extract<ExtensionSkipReason, "system" | "bundled" | "not-writable" | "unknown-install">;

export interface McpBinary {
	/** The `command` as configured. */
	command: string;
	/** Where it was found. */
	path: string;
	/** Symlinks resolved. */
	real: string;
	owner: McpOwner | null;
	skip: McpSkip | null;
	installed: string | null;
	/** A script (shebang, `.cmd`, `.js`) an interpreter loads lazily, as opposed to a native binary. */
	script: boolean;
}

export interface OwnerDeps {
	pathEnv: string;
	ctx: InstallContext;
	/** `<bin> <args>` stdout, or throws (python's `importlib.metadata`). */
	probe: (bin: string, args: string[]) => Promise<string>;
}

/** Plain-file executable lookup: a path is used as it is, a bare name is looked up along PATH (and Homebrew's prefixes). */
export function resolveMcpCommand(command: string, pathEnv: string, ctx: InstallContext): string | null {
	if (/[\\/]/.test(command)) return existsSync(command) ? command : null;
	const win = ctx.platform === "win32";
	const names = win && /\.(exe|cmd)$/i.test(command) ? [command] : launcherNames(command, ctx.platform);
	return findOnPath(
		names,
		pathEnv,
		ctx.platform,
		win ? [] : brewBinDirs().flatMap(dir => names.map(name => join(dir, name))),
	);
}

const DIST_SNIPPET = [
	"import sys, importlib.metadata as m",
	"for d in m.distributions():",
	" for e in (d.entry_points or ()):",
	"  if e.group == 'console_scripts' and e.name == sys.argv[1]:",
	"   print(d.metadata['Name']); raise SystemExit(0)",
	"raise SystemExit(1)",
].join("\n");

const VERSION_SNIPPET = "import sys, importlib.metadata as m; print(m.version(sys.argv[1]))";

/** Find `command`, follow its links, own it. Null when nothing on PATH (or at that path) runs. */
export async function detectMcpBinary(command: string, deps: OwnerDeps): Promise<McpBinary | null> {
	const { ctx } = deps;
	const path = resolveMcpCommand(command, deps.pathEnv, ctx);
	if (!path) return null;
	const facts = await readInstall(path, ctx, { kind: "mcp", command });
	const { real, mcp } = facts;
	let owner: McpOwner | null = facts.owner;
	let skip: McpSkip | null = facts.skip;
	if (!owner && skip === "unknown-install" && mcp.script && mcp.python) {
		// `#!/usr/bin/env python3` is looked up along PATH.
		const python = /[\\/]/.test(mcp.python) ? mcp.python : findOnPath([mcp.python], deps.pathEnv, ctx.platform);
		const dist = python
			? await deps.probe(python, ["-c", DIST_SNIPPET, mcp.name]).then(
					output => output.trim(),
					() => "",
				)
			: "";
		if (python && dist) {
			owner = { method: "pip", name: dist, python };
			skip = null;
		}
	}
	let installed = facts.installed;
	if (owner?.method === "pip") {
		const { python, name } = owner;
		// Check after the entry-point probe, not against a directory observed before python ran.
		try {
			accessSync(dirname(real), constants.W_OK);
		} catch {
			owner = null;
			skip = "not-writable";
		}
		installed = await deps.probe(python, ["-c", VERSION_SNIPPET, name]).then(
			output => output.trim() || null,
			() => null,
		);
	} else if (owner && !facts.writable) {
		owner = null;
		skip = "not-writable";
	}
	return { command, path, real, owner, skip, installed, script: mcp.script };
}
