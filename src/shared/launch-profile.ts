/**
 * Launch profiles: per-workspace agent CLI customisation configured in the
 * GUI (Settings → Launch Profile), persisted in GUI prefs under
 * `launchProfiles.<cwd>` by the core (`native/ompdesk/crates/core/src/prefs/launch_profile.rs`,
 * which also parses them and maps them to a spawn's flags). This module is pure
 * mapping/preview, no I/O: the renderer's effective-command preview and the
 * spawn's denylist (`omp-launch.ts`). `profileToFlags` is the core's mapping
 * again, held to the same rows (`launch-captured.json`).
 *
 * Flag mappings mirror packages/coding-agent/src/cli/flag-tables.ts.
 */

export interface LaunchProfile {
	/** --system-prompt <text>: full system prompt override. */
	systemPrompt?: string;
	/** --append-system-prompt <text>: appended to the default system prompt. */
	appendSystemPrompt?: string;
	/** --no-rules: skip rules files. */
	noRules?: boolean;
	/** --add-dir <path> (repeated): extra directories the agent may touch. */
	addDirs?: string[];
	/** --tools <csv>: tool whitelist (comma-separated, agent normalizes names). */
	tools?: string[];
	/** --no-lsp: disable LSP tooling. */
	noLsp?: boolean;
	/** --plan-yolo: auto-approve plan-mode execution. */
	planYolo?: boolean;
	/** --profile <name>: agent profile to boot from. */
	profile?: string;
	/** --session-dir <path>: where session files live. */
	sessionDir?: string;
	/** --config <path>: config file path. */
	config?: string;
}

/**
 * Flags the GUI/sidecar owns — session continuity (--session/--resume), the
 * rpc-ui transport (--mode), print/export plumbing, cwd, and process chrome —
 * plus credential-bearing flags that must stay in the protected provider
 * configuration flow. A launch profile must never override them: any of these
 * found in profile-sourced flags is dropped (value token included).
 */
export const DENYLISTED_FLAGS: readonly string[] = [
	"--session",
	"--mode",
	"--print",
	"--print-thoughts",
	"--export",
	"--cwd",
	"--resume",
	"--fork",
	"--help",
	"--version",
	"--no-pty",
	"--no-title",
	"--api-key",
	"--no-tools",
];

const DENYLISTED: Record<string, true> = Object.fromEntries(DENYLISTED_FLAGS.map(flag => [flag, true]));

/** Flags whose next token is always their value, even a flag-looking one: stock `STRING_VALUE_FLAGS`
 * (`cli/flag-tables`), held for the denylisted flags and those `profileToFlags` emits, because this must run
 * before omp starts and in the renderer's launch-command preview. The value of a kept one is DATA (a prompt, a
 * path, a tool list), never inspected as a smuggled flag: a prompt that happens to be "--session" is a value, as
 * stock reads it. Pinned to stock `flagConsumesValue` by `src/main/launch-profile-stock.test.ts`. */
const VALUED_FLAGS: Record<string, true> = {
	"--mode": true,
	"--export": true,
	"--cwd": true,
	"--fork": true,
	"--api-key": true,
	"--system-prompt": true,
	"--append-system-prompt": true,
	"--add-dir": true,
	"--tools": true,
	"--session-dir": true,
	"--config": true,
};

/** Flags that take the next token only when it is value-like and not empty: stock `OPTIONAL_VALUE_FLAGS`. */
const OPTIONAL_VALUE_FLAGS: Record<string, true> = { "--session": true, "--resume": true };

/** Whether stock reads `next` as the value of the bare flag `name` (stock `flagConsumesValue`). */
function consumesValue(name: string, next: string | undefined): boolean {
	if (next === undefined) return false;
	if (VALUED_FLAGS[name] === true) return true;
	return OPTIONAL_VALUE_FLAGS[name] === true && next !== "" && !next.startsWith("-");
}

/** Drop denylisted flags (and their separate value tokens) from a flag list.
 * Handles both `--flag value` and `--flag=value` forms. Pair-aware: the value
 * of a non-denylisted valued flag is pushed verbatim and never inspected, so
 * a legitimate value that merely looks like a protected flag survives. */
export function stripDenylistedFlags(flags: readonly string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < flags.length; i++) {
		const token = flags[i];
		if (!token.startsWith("--")) {
			out.push(token);
			continue;
		}
		const eq = token.indexOf("=");
		const name = eq === -1 ? token : token.slice(0, eq);
		if (DENYLISTED[name] === true) {
			// `--flag value`: the value goes with the flag. `--flag=value` carries it in the dropped token already.
			if (eq === -1 && consumesValue(name, flags[i + 1])) i++;
			continue;
		}
		out.push(token);
		// Value position of a valued non-denylisted flag is opaque data.
		if (eq === -1 && consumesValue(name, flags[i + 1])) {
			out.push(flags[i + 1]);
			i++;
		}
	}
	return out;
}

/** Map a launch profile to agent CLI flags. Output order is fixed so the
 * effective command line preview is stable. The denylist is enforced at the
 * sidecar spawn site over the combined user flags (sidecar.ts #spawn), not
 * here: this mapping emits only constant flag names and profile values are
 * data, so a value that looks like a protected flag must survive intact. */
export function profileToFlags(profile: LaunchProfile): string[] {
	const flags: string[] = [];
	if (typeof profile.systemPrompt === "string" && profile.systemPrompt.trim() !== "") {
		flags.push("--system-prompt", profile.systemPrompt);
	}
	if (typeof profile.appendSystemPrompt === "string" && profile.appendSystemPrompt.trim() !== "") {
		flags.push("--append-system-prompt", profile.appendSystemPrompt);
	}
	if (profile.noRules === true) flags.push("--no-rules");
	if (Array.isArray(profile.addDirs)) {
		for (const dir of profile.addDirs) {
			const trimmed = dir.trim();
			if (trimmed !== "") flags.push("--add-dir", trimmed);
		}
	}
	if (Array.isArray(profile.tools)) {
		const tools = profile.tools.map(tool => tool.trim()).filter(tool => tool !== "");
		if (tools.length > 0) flags.push("--tools", tools.join(","));
	}
	if (profile.noLsp === true) flags.push("--no-lsp");
	if (profile.planYolo === true) flags.push("--plan-yolo");
	if (typeof profile.profile === "string" && profile.profile.trim() !== "") {
		flags.push("--profile", profile.profile.trim());
	}
	if (typeof profile.sessionDir === "string" && profile.sessionDir.trim() !== "") {
		flags.push("--session-dir", profile.sessionDir.trim());
	}
	if (typeof profile.config === "string" && profile.config.trim() !== "") {
		flags.push("--config", profile.config.trim());
	}
	return flags;
}

/** Shell-safe charset: args outside it are single-quoted in the preview. */
export const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

function quoteShellArg(arg: string): string {
	if (arg.length > 0 && SHELL_SAFE.test(arg)) return arg;
	return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** Render a flag list as a shell command line suffix (read-only preview). */
export function flagsToCommandLine(flags: readonly string[]): string {
	return flags.map(quoteShellArg).join(" ");
}
