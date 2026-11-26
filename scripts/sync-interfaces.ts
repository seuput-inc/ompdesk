/**
 * Copies Jakub Krehel's interface skills (https://github.com/jakubkrehel/skills, MIT) at the pin in
 * `resources/omp-builtin/interfaces/interfaces-config.json` into `resources/omp-builtin/interfaces/skills/`, unmodified:
 * every Markdown file of each skill the pin's `curation.kept` names. Upstream's `agents/openai.yaml` (Codex metadata)
 * is never copied; any other file, an executable or a symlink fails the sync, and so does an upstream skill the
 * curation neither keeps nor excludes. `bun run sync:interfaces` (`INTERFACES_SRC=<clone>` uses a local clone);
 * `-- --check` compares the pin with the newest upstream.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import config from "../resources/omp-builtin/interfaces/interfaces-config.json" with { type: "json" };
import { withoutGitSelectors } from "../src/shared/git-env";
import { assertMitLicense } from "./sync-ponytail";

const ROOT = resolve(import.meta.dirname, "..");

export interface InterfacesPin {
	commit: string;
	version: string;
	curation: { kept: string[]; excluded: Record<string, string> };
}

export function syncInterfaces(source: string, root: string, { commit, version, curation }: InterfacesPin): void {
	if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("Expected a full jakubkrehel/skills commit SHA");
	const opts = { cwd: source, env: withoutGitSelectors(process.env) };
	const blob = (file: string) => execFileSync("git", ["cat-file", "blob", `${commit}:${file}`], opts);
	const plugin = JSON.parse(blob(".claude-plugin/plugin.json").toString());
	if (plugin.version !== version || plugin.license !== "MIT") {
		throw new Error(`Expected jakubkrehel/skills ${version} under MIT, found ${plugin.version} ${plugin.license}`);
	}
	const license = blob("LICENSE");
	assertMitLicense(license, "jakubkrehel/skills");
	const kept = new Set(curation.kept);
	const tree = execFileSync("git", ["ls-tree", "-rz", "--format=%(objectmode) %(path)", commit, "--", "skills"], opts)
		.toString()
		.split("\0")
		.filter(Boolean);
	const docs: string[] = [];
	const seen = new Set<string>();
	for (const entry of tree) {
		const [mode, file] = [entry.slice(0, 6), entry.slice(7)];
		const [, skill = "", rest = ""] = /^skills\/([^/]+)\/(.+)$/.exec(file) ?? [];
		if (mode !== "100644" || !skill) throw new Error(`Unexpected upstream file ${mode} ${file}; review it first`);
		if (skill in curation.excluded) {
			seen.add(skill);
			continue;
		}
		if (!kept.has(skill))
			throw new Error(`Upstream skill "${skill}" is new: keep or exclude it in the pin's curation`);
		seen.add(skill);
		if (rest === "agents/openai.yaml") continue;
		if (!/^[^/]+\.md$/.test(rest)) throw new Error(`Unexpected file ${file} in a kept skill; review it first`);
		docs.push(file);
	}
	const gone = [...kept, ...Object.keys(curation.excluded)].filter(skill => !seen.has(skill));
	if (gone.length) throw new Error(`Curated skills missing upstream: ${gone.join(", ")}`);
	const pack = join(root, "resources/omp-builtin/interfaces");
	rmSync(join(pack, "skills"), { recursive: true, force: true });
	const hashes: Record<string, string> = { LICENSE: createHash("sha256").update(license).digest("hex") };
	writeFileSync(join(root, "LICENSES/MIT-interfaces.txt"), license);
	for (const file of docs.sort()) {
		const bytes = blob(file);
		if (file.endsWith("/SKILL.md")) {
			const name = /^---\n(?:[^\n]*\n)*?name: (\S+)\n/.exec(bytes.toString())?.[1];
			if (name !== file.split("/")[1]) throw new Error(`${file} names itself "${name}"`);
		}
		mkdirSync(dirname(join(pack, file)), { recursive: true });
		writeFileSync(join(pack, file), bytes);
		hashes[file] = createHash("sha256").update(bytes).digest("hex");
	}
	writeFileSync(
		join(pack, "interfaces-manifest.json"),
		`${JSON.stringify({ commit, version, files: hashes }, null, "\t")}\n`,
	);
}

if (import.meta.main) {
	if (process.argv.includes("--check")) {
		execFileSync("bun", [join(ROOT, "scripts/skill-packs.ts"), "check", "interfaces"], { stdio: "inherit" });
	} else {
		const local = process.env.INTERFACES_SRC;
		const source = local || mkdtempSync(join(tmpdir(), "interfaces-src-"));
		try {
			if (!local)
				execFileSync(
					"git",
					["clone", "--bare", "--filter=blob:none", `https://github.com/${config.repo}`, source],
					{ env: withoutGitSelectors(process.env) },
				);
			syncInterfaces(source, ROOT, config);
			console.log(
				`Vendored ${config.curation.kept.length} interface skills from ${config.version} (${config.commit})`,
			);
		} finally {
			if (!local) rmSync(source, { recursive: true, force: true });
		}
	}
}
