/** Stock owns discovery and validation. The shared editor owns the Markdown and templates.
 * The core authorizes paths and performs the mutations. */

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { agentFileName, agentNameError, serializeAgentMarkdown } from "../../shared/agent-definition";
import { AGENT_TEMPLATES, templateDraft } from "../../shared/agent-templates";
import type {
	AgentFileScope,
	RpcAgentAuthoringInfo,
	RpcAgentFileContent,
	RpcAgentTemplatesInstallResult,
	RpcParsedAgentDefinition,
} from "../../shared/rpc-types";
import { CoreError, core } from "../core/process";
import { type LocalCommandContext, LocalCommandError, type LocalHandler } from "./types";

export type AgentDirs = Record<AgentFileScope, string>;

const MAX_AGENT_FILE_BYTES = 512 * 1024;

function scopeOf(value: unknown): AgentFileScope {
	if (value === "user" || value === "project") return value;
	throw new LocalCommandError('`scope` must be "user" or "project".', "invalid_scope");
}

interface AgentEntry extends AgentDirs {
	file: string;
	parent: string;
}

function entry(dirs: AgentDirs, file: unknown): AgentEntry {
	if (typeof file !== "string" || !path.isAbsolute(file) || path.extname(file) !== ".md") {
		throw new LocalCommandError("Not an agent definition file path.", "path_outside");
	}
	return {
		file,
		parent: path.resolve(path.dirname(file)),
		project: path.resolve(dirs.project),
		user: path.resolve(dirs.user),
	};
}

type DiskRequest =
	| ({ op: "locate" | "delete" } & AgentEntry)
	| { op: "prepare"; dir: string }
	| { op: "install"; dir: string; name: string }
	| { op: "write"; dir: string; name: string; previous?: AgentEntry };

async function disk<T>(request: DiskRequest, content?: string): Promise<T> {
	try {
		const { result } = await core().call<T>(
			"fs.agentFile",
			request,
			content === undefined ? undefined : { bin: Buffer.from(content, "utf8") },
		);
		return result;
	} catch (error) {
		if (error instanceof CoreError && ["path_outside", "invalid_name", "exists"].includes(error.code)) {
			throw new LocalCommandError(error.message, error.code);
		}
		throw error;
	}
}

/**
 * The checked path and the agents directory it sits directly in, or a
 * `path_outside` error. Symlinked directories (e.g. a dotfiles-managed
 * `~/.omp`) compare by their real path.
 */
export async function locateAgentFile(
	dirs: AgentDirs,
	filePath: unknown,
): Promise<{ file: string; scope: AgentFileScope }> {
	return disk({ op: "locate", ...entry(dirs, filePath) });
}

export async function readAgentFile(dirs: AgentDirs, filePath: unknown): Promise<RpcAgentFileContent> {
	const { file, scope } = await locateAgentFile(dirs, filePath);
	// Existing definitions have no Studio read cap. A core reply would buffer a second whole file.
	// As with Node's readFile, a final dotfiles link reads its target; a delete unlinks the entry instead.
	const flags =
		process.platform === "win32"
			? constants.O_RDONLY
			: constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY;
	const handle = await open(file, flags);
	try {
		const meta = await handle.stat();
		if (meta.isDirectory()) {
			throw Object.assign(new Error("EISDIR: illegal operation on a directory, read"), { code: "EISDIR" });
		}
		if (!meta.isFile()) {
			throw new LocalCommandError("The agent definition is not a regular file.", "invalid_content");
		}
		return { filePath: file, scope, content: await handle.readFile("utf8") };
	} finally {
		await handle.close();
	}
}

export interface WriteAgentFileParams {
	scope?: unknown;
	name?: unknown;
	content?: unknown;
	/** The file being edited; it may be replaced (or renamed away from). */
	replacePath?: unknown;
}

/**
 * Save a definition as `<dir>/<name>.md`. The content must parse to the same
 * name with a description (so discovery will accept it). Editing in place
 * overwrites; a new name or scope creates the new file first, then removes
 * the old one.
 */
export async function writeAgentFile(
	dirs: AgentDirs,
	params: WriteAgentFileParams,
	validate: (content: string, source: string) => Promise<RpcParsedAgentDefinition>,
): Promise<{ filePath: string }> {
	const scope = scopeOf(params.scope);
	if (typeof params.name !== "string") throw new LocalCommandError("`name` must be a string.", "invalid_name");
	const name = params.name.trim();
	const nameError = agentNameError(name);
	if (nameError) throw new LocalCommandError(`Invalid agent name (${nameError}).`, "invalid_name");
	if (typeof params.content !== "string")
		throw new LocalCommandError("`content` must be a string.", "invalid_content");
	const content = params.content;
	if (Buffer.byteLength(content, "utf8") > MAX_AGENT_FILE_BYTES) {
		throw new LocalCommandError("The agent file is too large.", "invalid_content");
	}
	const dir = path.resolve(dirs[scope]);
	const fileName = agentFileName(name);
	const source = path.join(dir, fileName);
	let parsed: RpcParsedAgentDefinition;
	try {
		parsed = await validate(content, source);
	} catch (cause) {
		throw new LocalCommandError(cause instanceof Error ? cause.message : String(cause), "invalid_content");
	}
	if (parsed.fields.name !== name) {
		throw new LocalCommandError("The frontmatter name does not match the file name.", "invalid_content");
	}

	const previous = params.replacePath == null ? undefined : entry(dirs, params.replacePath);
	await disk({ op: "write", dir, name: fileName, previous }, content);
	return { filePath: source };
}

export async function deleteAgentFile(dirs: AgentDirs, filePath: unknown): Promise<{ deleted: string }> {
	const at = entry(dirs, filePath);
	await disk({ op: "delete", ...at });
	return { deleted: at.file };
}

/**
 * Write the bundled templates (all, or `names`) into `dir`. Existing files are
 * never touched: a name whose file already exists is reported as skipped.
 */
export async function installAgentTemplates(
	dir: string,
	validate: (content: string, source: string) => Promise<RpcParsedAgentDefinition>,
	names?: readonly string[],
): Promise<RpcAgentTemplatesInstallResult> {
	const wanted = names ? AGENT_TEMPLATES.filter(template => names.includes(template.name)) : AGENT_TEMPLATES;
	const resolved = path.resolve(dir);
	await disk({ op: "prepare", dir: resolved });
	const installed: string[] = [];
	const skipped: string[] = [];
	for (const template of wanted) {
		const content = serializeAgentMarkdown(templateDraft(template));
		const name = agentFileName(template.name);
		await validate(content, path.join(resolved, name));
		try {
			await disk({ op: "install", dir: resolved, name }, content);
			installed.push(template.name);
		} catch (cause) {
			if (cause instanceof LocalCommandError && cause.code === "exists") skipped.push(template.name);
			else throw cause;
		}
	}
	return { dir: resolved, installed, skipped };
}

async function agentDirs(ctx: LocalCommandContext): Promise<AgentDirs> {
	const info = await ctx.bridge.request<RpcAgentAuthoringInfo>("get_agent_authoring");
	return info.dirs;
}

export const handlers: Record<string, LocalHandler> = {
	read_agent_file: async (command, ctx) => {
		const file = await readAgentFile(await agentDirs(ctx), command.filePath);
		try {
			const parsed = await ctx.bridge.request<RpcParsedAgentDefinition>("validate_agent_definition", {
				content: file.content,
				source: file.filePath,
			});
			return { ...file, parsed };
		} catch (cause) {
			return { ...file, parseError: cause instanceof Error ? cause.message : String(cause) };
		}
	},
	write_agent_file: async ({ scope, name, content, replacePath }, ctx) =>
		writeAgentFile(await agentDirs(ctx), { scope, name, content, replacePath }, (text, source) =>
			ctx.bridge.request<RpcParsedAgentDefinition>("validate_agent_definition", { content: text, source }),
		),
	delete_agent_file: async (command, ctx) => deleteAgentFile(await agentDirs(ctx), command.filePath),
	install_agent_templates: async (command, ctx) => {
		const dirs = await agentDirs(ctx);
		const names = Array.isArray(command.names)
			? command.names.filter((name): name is string => typeof name === "string")
			: undefined;
		return installAgentTemplates(
			dirs[scopeOf(command.scope)],
			(text, source) =>
				ctx.bridge.request<RpcParsedAgentDefinition>("validate_agent_definition", { content: text, source }),
			names,
		);
	},
};
