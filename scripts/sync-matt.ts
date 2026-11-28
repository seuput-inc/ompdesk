import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import config from "../resources/omp-builtin/matt/matt-config.json" with { type: "json" };
import { withoutGitSelectors } from "../src/shared/git-env";
import type { InterfacesPin } from "./sync-interfaces";
import { assertMitLicense } from "./sync-ponytail";

const ROOT = resolve(import.meta.dirname, "..");
const TEMPLATE = "skills/engineering/wizard/template.sh";

export function syncMatt(source: string, root: string, { commit, version, curation }: InterfacesPin): void {
	if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("Expected a full mattpocock/skills commit SHA");
	const opts = { cwd: source, env: withoutGitSelectors(process.env) };
	const git = (...args: string[]) => execFileSync("git", args, opts);
	if (git("cat-file", "-t", commit).toString().trim() !== "commit") throw new Error(`Not a commit: ${commit}`);
	const blob = (path: string) => git("cat-file", "blob", `${commit}:${path}`);
	const tree = git(
		"ls-tree",
		"-rz",
		"--format=%(objectmode) %(path)",
		commit,
		"--",
		"package.json",
		"LICENSE",
		"skills/engineering",
		"skills/productivity",
	)
		.toString()
		.split("\0")
		.filter(Boolean);
	for (const path of ["package.json", "LICENSE"]) {
		if (!tree.includes(`100644 ${path}`)) throw new Error(`Expected a plain ${path}`);
	}
	const pkg = JSON.parse(blob("package.json").toString());
	if (pkg.name !== "mattpocock-skills" || pkg.version !== version || pkg.license !== "MIT") {
		throw new Error(`Expected mattpocock-skills ${version} under MIT`);
	}
	const license = blob("LICENSE");
	assertMitLicense(license, "mattpocock/skills");
	const files = new Map([["LICENSE", license]]);
	const seen = new Set<string>();
	const paths = new Set<string>();
	for (const entry of tree) {
		const mode = entry.slice(0, 6);
		const path = entry.slice(7);
		if (path === "LICENSE" || path === "package.json") continue;
		if (mode === "100644" && /^skills\/(engineering|productivity)\/README\.md$/.test(path)) continue;
		const match = /^skills\/(?:engineering|productivity)\/([a-z0-9-]+)\/(.+)$/.exec(path);
		if (!match) throw new Error(`Unexpected upstream path ${path}`);
		const [, skill, rest] = match;
		if (rest === "SKILL.md") {
			if (seen.has(skill)) throw new Error(`Duplicate upstream skill ${skill}`);
			seen.add(skill);
		}
		if (Object.hasOwn(curation.excluded, skill)) continue;
		if (!curation.kept.includes(skill)) throw new Error(`Upstream skill "${skill}" is new; curate it first`);
		if (mode !== "100644") throw new Error(`Unexpected mode ${mode} for ${path}`);
		if (rest === "agents/openai.yaml") continue;
		if (!/^[a-zA-Z0-9_-]+\.md$/.test(rest) && path !== TEMPLATE) throw new Error(`Unexpected file ${path}`);
		const dest = `skills/${skill}/${rest}`;
		if (paths.has(dest.toLowerCase())) throw new Error(`Duplicate output path ${dest}`);
		paths.add(dest.toLowerCase());
		const bytes = blob(path);
		if (rest === "SKILL.md" && /^---\n(?:[^\n]*\n)*?name: (\S+)\n/.exec(bytes.toString())?.[1] !== skill) {
			throw new Error(`Unexpected skill name in ${path}`);
		}
		files.set(dest, bytes);
	}
	for (const skill of [...curation.kept, ...Object.keys(curation.excluded)]) {
		if (!seen.has(skill)) throw new Error(`Curated skill missing upstream: ${skill}`);
	}
	const pack = join(root, "resources/omp-builtin/matt");
	rmSync(join(pack, "skills"), { recursive: true, force: true });
	const hashes: Record<string, string> = {};
	for (const [path, bytes] of files) {
		const dest = path === "LICENSE" ? join(root, "LICENSES/MIT-matt.txt") : join(pack, path);
		mkdirSync(dirname(dest), { recursive: true });
		writeFileSync(dest, bytes, { mode: 0o644 });
		hashes[path] = createHash("sha256").update(bytes).digest("hex");
	}
	writeFileSync(
		join(pack, "matt-manifest.json"),
		`${JSON.stringify({ commit, version, files: hashes }, null, "\t")}\n`,
	);
}

if (import.meta.main) {
	if (process.argv.includes("--check")) {
		execFileSync("bun", [join(ROOT, "scripts/skill-packs.ts"), "check", "matt"], { stdio: "inherit" });
	} else {
		const local = process.env.MATT_SRC;
		const source = local || mkdtempSync(join(tmpdir(), "matt-src-"));
		try {
			if (!local) {
				execFileSync(
					"git",
					["clone", "--bare", "--filter=blob:none", `https://github.com/${config.repo}`, source],
					{
						env: withoutGitSelectors(process.env),
					},
				);
			}
			syncMatt(source, ROOT, config);
			console.log(`Vendored ${config.curation.kept.length} Matt skills from ${config.version} (${config.commit})`);
		} finally {
			if (!local) rmSync(source, { recursive: true, force: true });
		}
	}
}
