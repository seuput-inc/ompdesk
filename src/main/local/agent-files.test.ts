import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { emptyAgentDraft, serializeAgentMarkdown, splitFrontmatter } from "../../shared/agent-definition";
import { AGENT_TEMPLATES } from "../../shared/agent-templates";
import type { RpcParsedAgentDefinition } from "../../shared/rpc-types";
import {
	type AgentDirs,
	deleteAgentFile,
	installAgentTemplates,
	locateAgentFile,
	readAgentFile,
	writeAgentFile,
} from "./agent-files";

function agent(name: string, body = "Do the thing."): string {
	return serializeAgentMarkdown({ ...emptyAgentDraft(), name, description: `${name} agent`, instructions: body });
}

// Filesystem tests inject the bridge boundary; stock parsing is exercised by
// agent-studio-stock.e2e.ts, not duplicated inside the production writer.
async function validate(content: string): Promise<RpcParsedAgentDefinition> {
	const { frontmatter, body } = splitFrontmatter(content);
	const fields = parse(frontmatter ?? "") as RpcParsedAgentDefinition["fields"];
	if (!fields.name || !fields.description) throw new Error("Invalid agent field");
	return { fields, body };
}

let root: string;
let dirs: AgentDirs;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "ompdesk-agent-files-"));
	dirs = {
		user: path.join(root, "home", ".omp", "agent", "agents"),
		project: path.join(root, "repo", ".omp", "agents"),
	};
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("writeAgentFile", () => {
	it("creates <dir>/<name>.md (and the directory) without temp leftovers", async () => {
		const result = await writeAgentFile(
			dirs,
			{ scope: "project", name: "helper", content: agent("helper") },
			validate,
		);
		expect(result.filePath).toBe(path.join(dirs.project, "helper.md"));
		expect(await readFile(result.filePath, "utf8")).toBe(agent("helper"));
		expect(await readdir(dirs.project)).toEqual(["helper.md"]);
	});

	it("never replaces another agent's file", async () => {
		await writeAgentFile(dirs, { scope: "user", name: "helper", content: agent("helper", "first") }, validate);
		await expect(
			writeAgentFile(dirs, { scope: "user", name: "helper", content: agent("helper", "second") }, validate),
		).rejects.toMatchObject({ code: "exists" });
		expect(await readFile(path.join(dirs.user, "helper.md"), "utf8")).toContain("first");
		expect(await readdir(dirs.user)).toEqual(["helper.md"]);
	});

	it("overwrites the file being edited in place", async () => {
		const { filePath } = await writeAgentFile(
			dirs,
			{ scope: "user", name: "helper", content: agent("helper") },
			validate,
		);
		await writeAgentFile(
			dirs,
			{
				scope: "user",
				name: "helper",
				content: agent("helper", "edited"),
				replacePath: filePath,
			},
			validate,
		);
		expect(await readFile(filePath, "utf8")).toContain("edited");
	});

	it("renames and moves between scopes by writing the new file, then removing the old one", async () => {
		const { filePath } = await writeAgentFile(
			dirs,
			{ scope: "user", name: "helper", content: agent("helper") },
			validate,
		);
		const renamed = await writeAgentFile(
			dirs,
			{
				scope: "project",
				name: "helper2",
				content: agent("helper2"),
				replacePath: filePath,
			},
			validate,
		);
		expect(renamed.filePath).toBe(path.join(dirs.project, "helper2.md"));
		expect(await readdir(dirs.user)).toEqual([]);
	});

	it("leaves both files intact when moving onto an existing name", async () => {
		const old = await writeAgentFile(dirs, { scope: "user", name: "old", content: agent("old") }, validate);
		const taken = await writeAgentFile(dirs, { scope: "project", name: "taken", content: agent("taken") }, validate);
		await expect(
			writeAgentFile(
				dirs,
				{ scope: "project", name: "taken", content: agent("taken", "new body"), replacePath: old.filePath },
				validate,
			),
		).rejects.toMatchObject({ code: "exists", message: "An agent file named taken.md already exists." });
		expect(await readFile(old.filePath, "utf8")).toBe(agent("old"));
		expect(await readFile(taken.filePath, "utf8")).toBe(agent("taken"));
	});

	it("commits only one concurrent creation", async () => {
		const bodies = [agent("helper", "one"), agent("helper", "two")];
		const results = await Promise.allSettled(
			bodies.map(content => writeAgentFile(dirs, { scope: "project", name: "helper", content }, validate)),
		);
		const winner = results.findIndex(result => result.status === "fulfilled");
		expect(winner).not.toBe(-1);
		expect(results[1 - winner]).toMatchObject({ status: "rejected", reason: { code: "exists" } });
		expect(await readFile(path.join(dirs.project, "helper.md"), "utf8")).toBe(bodies[winner]);
		expect(await readdir(dirs.project)).toEqual(["helper.md"]);
	});

	it("accepts 512 KiB of UTF-8 and rejects the next byte before calling stock", async () => {
		const body = agent("limit");
		const remaining = 512 * 1024 - Buffer.byteLength(body);
		const content = body + "한".repeat(Math.floor(remaining / 3)) + ".".repeat(remaining % 3);
		const { filePath } = await writeAgentFile(dirs, { scope: "user", name: "limit", content }, validate);
		const oversized = { scope: "user", name: "limit", content: `${content}x`, replacePath: filePath };
		await expect(
			writeAgentFile(dirs, oversized, async () => {
				throw new Error("stock was called");
			}),
		).rejects.toMatchObject({ code: "invalid_content", message: "The agent file is too large." });
		expect(await readFile(filePath, "utf8")).toBe(content);
	});

	it.skipIf(process.platform === "win32")("masks a new file's 0644 mode and pins it on replacement", async () => {
		const params = { scope: "user", name: "mode", content: agent("mode") };
		const { filePath } = await writeAgentFile(dirs, params, validate);
		expect((await stat(filePath)).mode & 0o777).toBe(0o644 & ~process.umask());
		await chmod(filePath, 0o600);
		await writeAgentFile(dirs, { ...params, replacePath: filePath }, validate);
		expect((await stat(filePath)).mode & 0o777).toBe(0o644);
	});

	it("refuses names that are reserved, malformed or traverse paths", async () => {
		for (const name of ["main", "../escape", "a/b", "", ".hidden"]) {
			await expect(
				writeAgentFile(dirs, { scope: "user", name, content: agent("x") }, validate),
			).rejects.toMatchObject({
				code: "invalid_name",
			});
		}
		await expect(
			writeAgentFile(dirs, { scope: "elsewhere", name: "x", content: agent("x") }, validate),
		).rejects.toMatchObject({
			code: "invalid_scope",
		});
	});

	it("refuses a name mismatch and propagates validator failures", async () => {
		await expect(
			writeAgentFile(dirs, { scope: "user", name: "x", content: agent("y") }, validate),
		).rejects.toMatchObject({
			code: "invalid_content",
		});
		await expect(
			writeAgentFile(dirs, { scope: "user", name: "x", content: "---\nname: x\n---\nno description" }, validate),
		).rejects.toMatchObject({ code: "invalid_content" });
		await expect(
			writeAgentFile(dirs, { scope: "user", name: "x", content: "---\nname: [x\n---\nbroken" }, validate),
		).rejects.toMatchObject({ code: "invalid_content" });
	});

	it("preserves bridge validation errors and writes nothing before validation", async () => {
		const error = new Error("stock validation failure");
		await expect(
			writeAgentFile(dirs, { scope: "user", name: "x", content: agent("x") }, async () => {
				throw error;
			}),
		).rejects.toMatchObject({ code: "invalid_content", message: error.message });
		expect(await readdir(dirs.user).catch(() => [])).toEqual([]);
	});

	it("refuses a replacePath outside the agent directories", async () => {
		const outside = path.join(root, "outside.md");
		await writeFile(outside, agent("x"));
		await expect(
			writeAgentFile(dirs, { scope: "user", name: "x", content: agent("x"), replacePath: outside }, validate),
		).rejects.toMatchObject({ code: "path_outside" });
		expect(await readFile(outside, "utf8")).toBe(agent("x"));
	});
});

describe("locate / read / delete", () => {
	it("accepts only direct *.md children of the two directories", async () => {
		await mkdir(path.join(dirs.user, "nested"), { recursive: true });
		const cases = [
			path.join(dirs.user, "nested", "a.md"),
			path.join(dirs.user, "..", "agents-evil", "a.md"),
			path.join(dirs.user, "a.txt"),
			"relative/a.md",
			path.join(root, "a.md"),
		];
		for (const filePath of cases) {
			await expect(locateAgentFile(dirs, filePath)).rejects.toMatchObject({ code: "path_outside" });
		}
		expect(await locateAgentFile(dirs, path.join(dirs.project, "a.md"))).toEqual({
			file: path.join(dirs.project, "a.md"),
			scope: "project",
		});
	});

	it("uses project scope first when the roots coincide and decodes bytes as Node UTF-8", async () => {
		await mkdir(dirs.user, { recursive: true });
		const filePath = path.join(dirs.user, "raw.md");
		await writeFile(filePath, Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x80, 0, 0xff]));
		expect(await readAgentFile({ user: dirs.user, project: dirs.user }, filePath)).toEqual({
			filePath,
			scope: "project",
			content: "\ufeffa\ufffd\0\ufffd",
		});
	});

	it("opens existing empty and oversized definitions without applying the save limit", async () => {
		await mkdir(dirs.user, { recursive: true });
		const filePath = path.join(dirs.user, "import.md");
		for (const content of ["", "x".repeat(512 * 1024 + 1)]) {
			await writeFile(filePath, content);
			expect(await readAgentFile(dirs, filePath)).toEqual({ filePath, scope: "user", content });
		}
	});

	it.skipIf(process.platform === "win32")(
		"reads a linked definition, unlinks the entry and refuses devices",
		async () => {
			await mkdir(dirs.user, { recursive: true });
			await mkdir(dirs.project, { recursive: true });
			const source = path.join(dirs.project, "source.md");
			const linked = path.join(dirs.user, "linked.md");
			await writeFile(source, agent("source"));
			await symlink(source, linked);
			expect(await readAgentFile(dirs, linked)).toEqual({
				filePath: linked,
				scope: "user",
				content: agent("source"),
			});
			await deleteAgentFile(dirs, linked);
			expect(await readFile(source, "utf8")).toBe(agent("source"));
			await symlink("/dev/null", linked);
			await expect(readAgentFile(dirs, linked)).rejects.toMatchObject({ code: "invalid_content" });
		},
	);

	it("never recursively removes a directory named like a definition", async () => {
		const folder = path.join(dirs.user, "folder.md");
		await mkdir(folder, { recursive: true });
		await writeFile(path.join(folder, "keep"), "keep");
		await expect(readAgentFile(dirs, folder)).rejects.toMatchObject({ code: "EISDIR" });
		await expect(deleteAgentFile(dirs, folder)).rejects.toMatchObject({ code: "ERR_FS_EISDIR" });
		expect(await readFile(path.join(folder, "keep"), "utf8")).toBe("keep");
	});

	it("removes a directory link itself and leaves its contents alone", async () => {
		await mkdir(dirs.user, { recursive: true });
		const folder = path.join(root, "shared-agents");
		await mkdir(folder);
		await writeFile(path.join(folder, "keep"), "keep");
		const link = path.join(dirs.user, "linked.md");
		await symlink(folder, link, "junction");
		expect(await deleteAgentFile(dirs, link)).toEqual({ deleted: link });
		expect(await readdir(dirs.user)).toEqual([]);
		expect(await readFile(path.join(folder, "keep"), "utf8")).toBe("keep");
	});

	it("resolves a symlinked agents directory to its real path", async () => {
		const real = path.join(root, "dotfiles", "agents");
		await mkdir(real, { recursive: true });
		await mkdir(path.dirname(dirs.user), { recursive: true });
		await symlink(real, dirs.user, "junction");
		await writeFile(path.join(real, "a.md"), agent("a"));
		const file = await readAgentFile(dirs, path.join(real, "a.md"));
		expect(file.scope).toBe("user");
	});

	it("reads and deletes inside, refuses outside", async () => {
		const { filePath } = await writeAgentFile(
			dirs,
			{ scope: "project", name: "gone", content: agent("gone") },
			validate,
		);
		expect((await readAgentFile(dirs, filePath)).content).toBe(agent("gone"));
		await deleteAgentFile(dirs, filePath);
		expect(await readdir(dirs.project)).toEqual([]);
		const outside = path.join(root, "keep.md");
		await writeFile(outside, "keep");
		await expect(deleteAgentFile(dirs, outside)).rejects.toMatchObject({ code: "path_outside" });
		expect(await readFile(outside, "utf8")).toBe("keep");
	});
});

describe("installAgentTemplates", () => {
	it("writes every template once and leaves existing files untouched", async () => {
		await mkdir(dirs.user, { recursive: true });
		const mine = path.join(dirs.user, "debugger.md");
		await writeFile(mine, agent("debugger", "my own debugger"));

		const first = await installAgentTemplates(dirs.user, validate);
		expect(first.skipped).toEqual(["debugger"]);
		expect(first.installed).toHaveLength(AGENT_TEMPLATES.length - 1);
		expect(await readFile(mine, "utf8")).toContain("my own debugger");

		const second = await installAgentTemplates(dirs.user, validate);
		expect(second.installed).toEqual([]);
		expect(second.skipped).toHaveLength(AGENT_TEMPLATES.length);

		for (const template of AGENT_TEMPLATES.filter(entry => entry.name !== "debugger")) {
			const { frontmatter } = splitFrontmatter(await readFile(path.join(dirs.user, `${template.name}.md`), "utf8"));
			const fields = parse(frontmatter ?? "");
			expect(fields.name).toBe(template.name);
			expect(fields.tools).toEqual(template.tools);
		}
	});

	it("installs a named subset", async () => {
		const result = await installAgentTemplates(dirs.project, validate, ["frontend", "nope"]);
		expect(result.installed).toEqual(["frontend"]);
		expect(await readdir(dirs.project)).toEqual(["frontend.md"]);
	});

	it("prepares the directory even when no template matches", async () => {
		const result = await installAgentTemplates(dirs.user, validate, ["absent"]);
		expect(result).toEqual({ dir: dirs.user, installed: [], skipped: [] });
		expect(await readdir(dirs.user)).toEqual([]);
	});

	it("validates even an existing template and keeps only installations before a validation failure", async () => {
		await mkdir(dirs.user, { recursive: true });
		const existing = path.join(dirs.user, "frontend.md");
		await writeFile(existing, "my frontend");
		const calls: string[] = [];
		await expect(
			installAgentTemplates(dirs.user, async (content, source) => {
				calls.push(path.basename(source));
				if (source === existing) throw new Error("stock refused");
				return validate(content);
			}),
		).rejects.toThrow("stock refused");
		expect(calls).toEqual(["code-explorer.md", "frontend.md"]);
		expect((await readdir(dirs.user)).sort()).toEqual(["code-explorer.md", "frontend.md"]);
		expect(await readFile(existing, "utf8")).toBe("my frontend");
	});
});
