/**
 * A setup-script draft for a repository that has no `.ompdesk/worktree-setup`, built from another tool's config in its
 * main checkout. The person sees the draft and saves it; nothing here runs a command. Orca (MIT), re-implemented from
 * `src/shared/workspace-setup/`:
 * - order, Superset and cmux: `setup-script-imports.ts:35-237`; parsers: `setup-script-import-parsers.ts:9-78`
 * - limits: `setup-script-import-limits.ts:3-34`, `setup-script-import-command-limits.ts:8-49`
 * - Conductor: `setup-script-import-conductor.ts:10-121`; Codex: `setup-script-import-codex-environment.ts:11-208`
 * - Cursor: `setup-script-import-cursor-environment.ts:5-24`; Capy: `setup-script-import-capy.ts:5-27`
 * - package manager: `setup-script-package-manager-suggestion.ts:8-115`
 * - Copilot: `setup-script-import-copilot-setup-steps.ts:10-127`; Dev Container: `setup-script-import-devcontainer.ts:10-134`
 *
 * Orca's `ORCA_WORKTREE_PATH` is the hook's `OMPDESK_WORKTREE_PATH` (`supervise/hook.rs`). Orca's skipped-field lists
 * are not kept: the draft is shown whole before it is saved.
 *
 * Main, not the core: the YAML read is main's `yaml` package (native-rust › what stays TypeScript).
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parseDocument } from "yaml";
import { SHELL_SAFE } from "../../../shared/launch-profile";
import { primaryRoot } from "./changes";

export type SetupDraftSource =
	| "superset"
	| "conductor"
	| "codex"
	| "cmux"
	| "cursor"
	| "copilot"
	| "capy"
	| "devcontainer"
	| "package-manager";

export interface SetupDraft {
	source: SetupDraftSource;
	/** The repository-relative file the commands came from, forward slashes. */
	file: string;
	/** One shell command per entry, trimmed, none empty. */
	commands: string[];
}

/** A repository-relative file's text: null when missing or over `FILE_MAX_BYTES`; a lockfile reads as "". */
type Read = (relative: string) => string | null;
type Json = Record<string, unknown>;

const FILE_MAX_BYTES = 256 * 1024;
const FIELD_MAX_BYTES = 64 * 1024;
const MAX_COMMAND_PARTS = 256;
const MAX_CMUX_COMMANDS = 256;
const MAX_KEYWORDS = 64;
const MAX_TOML_LINES = 4096;
const MAX_YAML_ALIASES = 100;
// biome-ignore lint/suspicious/noTemplateCurlyInString: a shell variable the hook sets, written into the draft as is
const WORKTREE_PATH = "${OMPDESK_WORKTREE_PATH}";

const SUPERSET = ".superset/config.json";
const SUPERSET_LOCAL = ".superset/config.local.json";
const CONDUCTOR = ".conductor/settings.toml";
const CONDUCTOR_LOCAL = ".conductor/settings.local.toml";
const CONDUCTOR_LEGACY = "conductor.json";
const CODEX = ".codex/environments/environment.toml";
const CMUX = [".cmux/cmux.json", "cmux.json"];
const CURSOR = ".cursor/environment.json";
const CAPY = ".capy/setup.json";
const PACKAGE_JSON = "package.json";
const MANAGERS = ["pnpm", "bun", "yarn", "npm"] as const;
const LOCKFILES = [
	{ path: "pnpm-lock.yaml", manager: "pnpm" },
	{ path: "bun.lock", manager: "bun" },
	{ path: "bun.lockb", manager: "bun" },
	{ path: "yarn.lock", manager: "yarn" },
	{ path: "package-lock.json", manager: "npm" },
	{ path: "npm-shrinkwrap.json", manager: "npm" },
] as const;
const COPILOT = ".github/workflows/copilot-setup-steps.yml";
const DEVCONTAINER = [".devcontainer/devcontainer.json", ".devcontainer.json"];

const FILES = [
	SUPERSET,
	SUPERSET_LOCAL,
	CONDUCTOR,
	CONDUCTOR_LOCAL,
	CONDUCTOR_LEGACY,
	CODEX,
	...CMUX,
	CURSOR,
	CAPY,
	PACKAGE_JSON,
	...LOCKFILES.map(lockfile => lockfile.path),
	COPILOT,
	...DEVCONTAINER,
];

/** The draft for the repository `cwd` is in, from its main checkout; null outside a repository or with nothing found. */
export async function setupDraft(cwd: string): Promise<SetupDraft | null> {
	let root: string;
	try {
		root = await primaryRoot(cwd);
	} catch {
		return null;
	}
	const files = new Map<string, string>();
	await Promise.all(
		FILES.map(async relative => {
			const lockfile = LOCKFILES.some(entry => entry.path === relative);
			const text = await readCapped(path.join(root, relative), lockfile);
			if (text !== null) files.set(relative, text);
		}),
	);
	return draftFrom(relative => files.get(relative) ?? null);
}

/** The file's text, "" for a lockfile (only its presence counts); null when missing, not a file or over the cap. */
async function readCapped(file: string, presenceOnly: boolean): Promise<string | null> {
	try {
		const stat = await fs.stat(file);
		if (!stat.isFile()) return null;
		if (presenceOnly) return "";
		return stat.size <= FILE_MAX_BYTES ? await fs.readFile(file, "utf8") : null;
	} catch {
		return null;
	}
}

/** Orca's precedence: workspace tools first; CI runner and container setups below the lockfile guess. */
const PROVIDERS: ReadonlyArray<(read: Read) => SetupDraft | null> = [
	superset,
	conductor,
	codex,
	cmux,
	cursor,
	capy,
	packageManager,
	copilot,
	devcontainer,
];

/** The first provider's draft. */
export function draftFrom(read: Read): SetupDraft | null {
	for (const provider of PROVIDERS) {
		const found = provider(read);
		if (found) return found;
	}
	return null;
}

function draft(source: SetupDraftSource, file: string, commands: string[]): SetupDraft | null {
	return commands.length > 0 && fits(commands.join("\n")) ? { source, file, commands } : null;
}

/** Within Orca's field limit (UTF-8 bytes; a string's UTF-16 length never exceeds them). */
function fits(text: string): boolean {
	return text.length <= FIELD_MAX_BYTES && Buffer.byteLength(text, "utf8") <= FIELD_MAX_BYTES;
}

function command(value: string): string {
	if (value.length > FIELD_MAX_BYTES) return "";
	const trimmed = value.trim();
	return trimmed && fits(trimmed) ? trimmed : "";
}

/** A string is one command, a list of strings one each (other items dropped); anything else, or a longer list, none. */
function commandsOf(value: unknown): string[] {
	if (typeof value === "string") {
		const one = command(value);
		return one ? [one] : [];
	}
	if (!Array.isArray(value) || value.length > MAX_COMMAND_PARTS) return [];
	return value.map(item => (typeof item === "string" ? command(item) : "")).filter(Boolean);
}

function record(value: unknown): Json | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function json(text: string | null): Json | null {
	if (!text) return null;
	try {
		return record(JSON.parse(text));
	} catch {
		return null;
	}
}

/** JSON with comments and trailing commas, as devcontainer.json and Cursor's environment.json allow. */
function jsonc(text: string | null): Json | null {
	if (!text) return null;
	return json(stripJsonc(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text));
}

/** The index just past the JSON string that opens at `at`. */
function stringEnd(text: string, at: number): number {
	let end = at + 1;
	while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
	return end + 1;
}

/** `text` without comments, then without trailing commas, both outside strings. */
function stripJsonc(text: string): string {
	let bare = "";
	for (let at = 0; at < text.length; ) {
		if (text[at] === '"') {
			const end = stringEnd(text, at);
			bare += text.slice(at, end);
			at = end;
		} else if (text.startsWith("//", at)) {
			const end = text.indexOf("\n", at);
			at = end === -1 ? text.length : end;
		} else if (text.startsWith("/*", at)) {
			const end = text.indexOf("*/", at + 2);
			if (end === -1) return text;
			bare += " ";
			at = end + 2;
		} else {
			bare += text[at];
			at++;
		}
	}
	const closes = /\s*[}\]]/y;
	let out = "";
	for (let at = 0; at < bare.length; ) {
		if (bare[at] === '"') {
			const end = stringEnd(bare, at);
			out += bare.slice(at, end);
			at = end;
			continue;
		}
		closes.lastIndex = at + 1;
		if (bare[at] !== "," || !closes.test(bare)) out += bare[at];
		at++;
	}
	return out;
}

function superset(read: Read): SetupDraft | null {
	const config = json(read(SUPERSET));
	if (!config) return null;
	const override = json(read(SUPERSET_LOCAL))?.setup;
	const base = commandsOf(config.setup);
	if (typeof override === "string" || Array.isArray(override)) {
		return draft("superset", SUPERSET_LOCAL, commandsOf(override));
	}
	const around = record(override);
	const commands = around ? [...commandsOf(around.before), ...base, ...commandsOf(around.after)] : base;
	return draft("superset", SUPERSET, commands);
}

function conductor(read: Read): SetupDraft | null {
	const shared = read(CONDUCTOR);
	const local = read(CONDUCTOR_LOCAL);
	const fromLocal = local ? commandsOf(tomlString(local, "scripts", "setup")) : [];
	if (fromLocal.length > 0) return draft("conductor", CONDUCTOR_LOCAL, fromLocal);
	// Conductor ignores conductor.json once settings.toml exists.
	if (shared) return draft("conductor", CONDUCTOR, commandsOf(tomlString(shared, "scripts", "setup")));
	const scripts = record(json(read(CONDUCTOR_LEGACY))?.scripts);
	return scripts ? draft("conductor", CONDUCTOR_LEGACY, commandsOf(scripts.setup)) : null;
}

function codex(read: Read): SetupDraft | null {
	const text = read(CODEX);
	return text ? draft("codex", CODEX, commandsOf(tomlString(text, "setup", "script"))) : null;
}

/** The last string `key` is set to in `[section]`, read line by line as Orca's Codex reader does. */
function tomlString(text: string, section: string, key: string): string | undefined {
	const lines = text.split(/\r?\n/);
	if (lines.length > MAX_TOML_LINES) return undefined;
	const assignment = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`);
	let current = "";
	let value: string | undefined;
	for (let index = 0; index < lines.length; index++) {
		const header = lines[index].trim().match(/^\[([A-Za-z0-9_.-]+)\]\s*(?:#.*)?$/);
		if (header) {
			current = header[1];
			continue;
		}
		const match = current === section ? lines[index].match(assignment) : null;
		if (!match) continue;
		const parsed = tomlValue(lines, index, match[1]);
		index = parsed.end;
		value = parsed.value;
	}
	return value;
}

function tomlValue(lines: string[], start: number, raw: string): { value: string; end: number } {
	const value = raw.trimStart();
	for (const delimiter of ['"""', "'''"]) {
		if (value.startsWith(delimiter)) return tomlMultiline(lines, start, value.slice(3), delimiter);
	}
	if (value.startsWith('"')) {
		const quoted = value.slice(0, quoteEnd(value, '"') + 1);
		try {
			return { value: String(JSON.parse(quoted)), end: start };
		} catch {
			return { value: quoted.slice(1, -1), end: start };
		}
	}
	if (value.startsWith("'")) return { value: value.slice(1, quoteEnd(value, "'")), end: start };
	// shortcut: a TOML array or inline table reads as nothing; parse them if Conductor configs turn out to use them.
	if (value.startsWith("[") || value.startsWith("{")) return { value: "", end: start };
	return { value: value.replace(/\s+#.*$/, "").trim(), end: start };
}

function tomlMultiline(
	lines: string[],
	start: number,
	first: string,
	delimiter: string,
): { value: string; end: number } {
	let text = "";
	for (let index = start; index < lines.length; index++) {
		const line = index === start ? first : lines[index];
		const close = line.indexOf(delimiter);
		if (close !== -1) return { value: text + line.slice(0, close), end: index };
		text += `${line}\n`;
	}
	return { value: text.trimEnd(), end: lines.length - 1 };
}

function quoteEnd(value: string, quote: string): number {
	for (let index = 1; index < value.length; index++) {
		if (value[index] !== quote) continue;
		let slashes = 0;
		for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor--) slashes++;
		if (quote === "'" || slashes % 2 === 0) return index;
	}
	return value.length - 1;
}

const CMUX_SETUP_LABELS = ["setup", "project setup", "workspace setup", "repository setup"];
const CMUX_SETUP_KEYWORDS = ["setup", "init", "initialize", "install"];

function cmux(read: Read): SetupDraft | null {
	for (const file of CMUX) {
		const listed = json(read(file))?.commands;
		const entries: unknown[] = Array.isArray(listed) ? listed : [];
		if (entries.length > MAX_CMUX_COMMANDS) continue;
		for (const entry of entries) {
			const item = record(entry);
			const found = item && isCmuxSetup(item) ? draft("cmux", file, commandsOf(item.command)) : null;
			if (found) return found;
		}
	}
	return null;
}

function isCmuxSetup(item: Json): boolean {
	const run = item.command;
	if (typeof run !== "string" || !fits(run) || !run.trim()) return false;
	const labels = [matchText(item.name), matchText(item.title)].filter(Boolean);
	if (labels.some(label => CMUX_SETUP_LABELS.includes(label))) return true;
	const listed = item.keywords;
	const keywords = Array.isArray(listed) && listed.length <= MAX_KEYWORDS ? listed.map(matchText) : [];
	if (!keywords.some(keyword => CMUX_SETUP_KEYWORDS.includes(keyword))) return false;
	return labels.some(label => label.includes("setup")) || /\bsetup\b/.test(matchText(run));
}

function matchText(value: unknown): string {
	return typeof value === "string" && fits(value) ? value.trim().toLowerCase().replace(/\s+/g, " ") : "";
}

function cursor(read: Read): SetupDraft | null {
	const config = jsonc(read(CURSOR));
	return config ? draft("cursor", CURSOR, commandsOf(config.install)) : null;
}

function capy(read: Read): SetupDraft | null {
	// initialize runs once per fresh clone, which is what a setup script is.
	const scripts = record(json(read(CAPY))?.scripts);
	return scripts ? draft("capy", CAPY, commandsOf(scripts.initialize)) : null;
}

function packageManager(read: Read): SetupDraft | null {
	const manifest = json(read(PACKAGE_JSON));
	if (!manifest) return null;
	const declared = manifest.packageManager;
	const spelled = typeof declared === "string" && fits(declared) ? declared.trim().toLowerCase() : "";
	const named = MANAGERS.find(manager => spelled.startsWith(`${manager}@`));
	if (named) return draft("package-manager", PACKAGE_JSON, [`${named} install`]);
	const present = LOCKFILES.filter(lockfile => read(lockfile.path) !== null);
	if (new Set(present.map(lockfile => lockfile.manager)).size > 1) return null;
	const [lockfile] = present;
	return lockfile
		? draft("package-manager", lockfile.path, [`${lockfile.manager} install`])
		: draft("package-manager", PACKAGE_JSON, ["npm install"]);
}

// The only job the agent runs; any other job in the file is ignored there too.
const COPILOT_JOB = "copilot-setup-steps";
const POSIX_SHELLS = ["bash", "sh"];
// sudo administers the throwaway runner (freeing disk space); runner variables have no local value.
const RUNNER_ONLY = /(^|[^A-Za-z0-9_])sudo\b|\$\{?(GITHUB|RUNNER)_[A-Z_]+/;
const GITHUB_WORKSPACE = /\$\{GITHUB_WORKSPACE\}|\$GITHUB_WORKSPACE\b/g;
const SAFE_FOLDER = /^[A-Za-z0-9_@%+=:,./][A-Za-z0-9_@%+=:,./-]*$/;

function yaml(text: string | null): Json | null {
	if (!text) return null;
	try {
		// Actions takes anchors but not `<<` merge keys, so none are expanded; aliases are bounded.
		const doc = parseDocument(text, { merge: false, logLevel: "silent", prettyErrors: false, uniqueKeys: true });
		return doc.errors.length === 0 ? record(doc.toJS({ maxAliasCount: MAX_YAML_ALIASES })) : null;
	} catch {
		return null;
	}
}

function copilot(read: Read): SetupDraft | null {
	const workflow = yaml(read(COPILOT));
	const job = record(record(workflow?.jobs)?.[COPILOT_JOB]);
	const steps = job?.steps;
	if (!workflow || !job || !Array.isArray(steps) || steps.length > MAX_COMMAND_PARTS) return null;
	const workflowRun = record(record(workflow.defaults)?.run);
	const jobRun = record(record(job.defaults)?.run);
	const shell = jobRun?.shell ?? workflowRun?.shell;
	const folder = jobRun?.["working-directory"] ?? workflowRun?.["working-directory"];
	const imported: Array<{ run: string; folder?: string }> = [];
	for (const entry of steps) {
		const step = copilotStep(record(entry), shell, folder);
		if (step) imported.push(step);
	}
	// Each Actions step is its own process, so a subshell keeps one step's cd/exit/set from leaking.
	const commands = imported.map(step => {
		if (step.folder) return `(\ncd ${step.folder} || exit 1\n${step.run}\n)`;
		return imported.length === 1 ? step.run : `(\n${step.run}\n)`;
	});
	return draft("copilot", COPILOT, commands);
}

function copilotStep(
	step: Json | null,
	defaultShell: unknown,
	defaultFolder: unknown,
): { run: string; folder?: string } | null {
	// The workspace is already a checkout; other actions (toolchain installers) have no shell form.
	if (!step || typeof step.uses === "string") return null;
	const raw = commandsOf(step.run).join("\n");
	if (!raw) return null;
	const shell = step.shell ?? defaultShell;
	if (shell !== undefined && (typeof shell !== "string" || !POSIX_SHELLS.includes(shell.trim()))) return null;
	// Conditions and step env are evaluated by Actions; running the step without them would change it.
	if (step.if !== undefined || step.env !== undefined) return null;
	const run = raw.replace(GITHUB_WORKSPACE, WORKTREE_PATH);
	if (run.includes("${{") || RUNNER_ONLY.test(run)) return null;
	const folder = step["working-directory"] ?? defaultFolder;
	if (folder === undefined) return { run };
	return typeof folder === "string" && SAFE_FOLDER.test(folder) ? { run, folder } : null;
}

// Creation-time lifecycle commands, in the order the spec runs them; together they are the one-time setup.
const LIFECYCLE = ["onCreateCommand", "updateContentCommand", "postCreateCommand"];
const DEVCONTAINER_VARIABLES: Array<[RegExp, string]> = [
	// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, the worktree folder's name
	[/\$\{(?:container|local)WorkspaceFolderBasename\}/g, "${OMPDESK_WORKTREE_PATH##*/}"],
	[/\$\{(?:container|local)WorkspaceFolder\}/g, WORKTREE_PATH],
	// biome-ignore lint/suspicious/noTemplateCurlyInString: a replacement pattern naming the shell variable
	[/\$\{(?:local|container)Env:([A-Za-z_][A-Za-z0-9_]*)\}/g, "${$1}"],
];
// Leftover spec variables (`${localEnv:X:default}`) are a shell "bad substitution" error.
const UNREWRITTEN = /\$\{(?:(?:local|container)Env:|devcontainerId\}|(?:container|local)WorkspaceFolder)/;

function devcontainer(read: Read): SetupDraft | null {
	for (const file of DEVCONTAINER) {
		const config = jsonc(read(file));
		if (config)
			return draft(
				"devcontainer",
				file,
				LIFECYCLE.flatMap(field => lifecycle(config[field])),
			);
	}
	return null;
}

/** A string runs in a shell, a list is argv, an object is named commands the spec runs in parallel (here in order). */
function lifecycle(value: unknown): string[] {
	const named = record(value);
	if (!named) {
		const one = devcontainerCommand(value);
		return one ? [one] : [];
	}
	const values = Object.values(named);
	return values.length > MAX_COMMAND_PARTS ? [] : values.map(devcontainerCommand).filter(Boolean);
}

function devcontainerCommand(value: unknown): string {
	if (typeof value === "string") {
		let text = value;
		for (const [pattern, replacement] of DEVCONTAINER_VARIABLES) text = text.replace(pattern, replacement);
		return UNREWRITTEN.test(text) ? "" : command(text);
	}
	// argv skips the shell; only join it when no argument would need quoting to survive one.
	if (!Array.isArray(value) || value.length === 0) return "";
	if (!value.every(arg => typeof arg === "string" && SHELL_SAFE.test(arg))) return "";
	return command(value.join(" "));
}
