import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { expect, it } from "vitest";
import pin from "../resources/omp-builtin/matt/matt-config.json";
import manifest from "../resources/omp-builtin/matt/matt-manifest.json";
import { gitSync, initRepo } from "../src/main/local/git/test-repos";
import { syncMatt } from "./sync-matt";

const ROOT = join(__dirname, "..");
const PACK = "resources/omp-builtin/matt";
const LICENSE = "LICENSES/MIT-matt.txt";

function filesAt(pack: string): string[] {
	return readdirSync(pack, { recursive: true, withFileTypes: true })
		.filter(entry => !entry.isDirectory())
		.map(entry => {
			expect(entry.isFile(), entry.name).toBe(true);
			return relative(pack, join(entry.parentPath, entry.name)).split(sep).join("/");
		})
		.sort();
}

it("ships exactly the curated skills and records the bytes and MIT notice of the pin", () => {
	const pack = join(ROOT, PACK);
	expect(pin.repo).toBe("mattpocock/skills");
	expect(pin.commit).toMatch(/^[0-9a-f]{40}$/);
	expect(manifest).toMatchObject({ commit: pin.commit, version: pin.version });
	expect(readdirSync(join(pack, "skills")).sort()).toEqual([...pin.curation.kept].sort());
	expect(pin.curation.kept).toHaveLength(13);
	expect(pin.curation.excluded).toHaveProperty("triage");
	expect(pin.curation.excluded).toHaveProperty("improve-codebase-architecture");
	expect(filesAt(pack)).toEqual(
		[
			"matt-config.json",
			"matt-manifest.json",
			...Object.keys(manifest.files).filter(file => file !== "LICENSE"),
		].sort(),
	);
	expect(manifest.files).toHaveProperty("LICENSE");
	expect(Object.keys(manifest.files)).toContain("skills/wizard/template.sh");
	for (const name of pin.curation.kept) expect(Object.keys(manifest.files)).toContain(`skills/${name}/SKILL.md`);
	for (const [file, hash] of Object.entries(manifest.files)) {
		if (file !== "LICENSE" && file !== "skills/wizard/template.sh")
			expect(file).toMatch(/^skills\/[a-z0-9-]+\/[\w-]+\.md$/);
		const path = file === "LICENSE" ? join(ROOT, LICENSE) : join(pack, file);
		expect(createHash("sha256").update(readFileSync(path)).digest("hex"), file).toBe(hash);
	}
});

it("copies committed blobs only and refuses unreviewed files, modes, skills and license changes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "matt-sync-"));
	const source = join(dir, "upstream");
	const output = join(dir, "output");
	try {
		await initRepo(source);
		const write = (file: string, bytes: string | Buffer) => {
			mkdirSync(dirname(join(source, file)), { recursive: true });
			writeFileSync(join(source, file), bytes);
		};
		const curation = { kept: ["wizard"], excluded: { triage: "unsafe" } };
		const skill = "skills/engineering/wizard";
		const template = `${skill}/template.sh`;
		const license = readFileSync(join(ROOT, LICENSE));
		write("LICENSE", license);
		write("package.json", JSON.stringify({ name: "mattpocock-skills", version: "2.0.0", license: "MIT" }));
		write("skills/in-progress/ignore/code.js", "ignored");
		write("skills/misc/ignore/script.sh", "ignored");
		write("skills/engineering/README.md", "ignored");
		write("skills/productivity/triage/SKILL.md", "excluded");
		write(`${skill}/SKILL.md`, "---\nname: wizard\n---\n");
		write(`${skill}/agents/openai.yaml`, "ignored");
		write(template, "exit 99\n");
		gitSync(source, "add", "-A");
		const indexedCommit = () => gitSync(source, "commit-tree", gitSync(source, "write-tree"), "-m", "fixture");
		const commit = indexedCommit();
		const sync = (sha = commit, version = "2.0.0") => syncMatt(source, output, { commit: sha, version, curation });
		write(template, "dirty worktree");
		sync();
		expect(filesAt(join(output, PACK))).toEqual([
			"matt-manifest.json",
			"skills/wizard/SKILL.md",
			"skills/wizard/template.sh",
		]);
		const copied = join(output, PACK, "skills/wizard/template.sh");
		expect(readFileSync(copied, "utf8")).toBe("exit 99\n");
		if (process.platform !== "win32") expect(statSync(copied).mode & 0o111).toBe(0);
		expect(readFileSync(join(output, LICENSE))).toEqual(license);
		expect(() => sync(commit, "1.0.0")).toThrow(/1\.0\.0/);
		const id = gitSync(source, "rev-parse", `${commit}:${template}`);
		for (const [mode, path, error] of [
			["100755", template, /mode/],
			["120000", `${skill}/link.md`, /mode/],
			["100644", `${skill}/extra.sh`, /unexpected file/i],
			["100644", `${skill}/scripts/notes.md`, /unexpected file/i],
			["100644", "skills/productivity/new/SKILL.md", /new/],
			["100644", "skills/productivity/notes.json", /unexpected upstream path/i],
			["100644", "LICENSE", /license terms changed/i],
		] as const) {
			gitSync(source, "read-tree", commit);
			gitSync(source, "update-index", "--add", "--cacheinfo", `${mode},${id},${path}`);
			expect(() => sync(indexedCommit()), path).toThrow(error);
		}
		gitSync(source, "read-tree", commit);
		gitSync(source, "update-index", "--force-remove", "skills/productivity/triage/SKILL.md");
		expect(() => sync(indexedCommit())).toThrow(/missing upstream: triage/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
