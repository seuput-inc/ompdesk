import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { expect, it } from "vitest";
import pin from "../../../resources/omp-builtin/interfaces/interfaces-config.json";
import manifest from "../../../resources/omp-builtin/interfaces/interfaces-manifest.json";
import { syncInterfaces } from "../../../scripts/sync-interfaces";
import { gitSync, initRepo } from "../local/git/test-repos";

const ROOT = join(__dirname, "../../..");
const BUILTIN = join(ROOT, "resources/omp-builtin");
const PACK = "resources/omp-builtin/interfaces";
const LICENSE = "LICENSES/MIT-interfaces.txt";

function packFiles(root: string): string[] {
	const pack = join(root, PACK);
	return readdirSync(pack, { recursive: true, withFileTypes: true })
		.filter(entry => !entry.isDirectory())
		.map(entry => {
			expect(entry.isFile(), entry.name).toBe(true);
			return relative(pack, join(entry.parentPath, entry.name)).split(sep).join("/");
		})
		.sort();
}

it("ships the kept skills' Markdown only, with the bytes and license recorded at the pin", () => {
	expect(pin.repo).toBe("jakubkrehel/skills");
	expect(pin.commit).toMatch(/^[0-9a-f]{40}$/);
	expect(manifest).toMatchObject({ commit: pin.commit, version: pin.version });
	const files = packFiles(ROOT);
	expect(files).toEqual(
		["interfaces-config.json", "interfaces-manifest.json", ...Object.keys(manifest.files)]
			.filter(file => file !== "LICENSE")
			.sort(),
	);
	expect(files.filter(file => file.startsWith("skills/")).every(file => file.endsWith(".md"))).toBe(true);
	expect(readdirSync(join(ROOT, PACK, "skills")).sort()).toEqual([...pin.curation.kept].sort());
	for (const [file, hash] of Object.entries(manifest.files)) {
		const bytes = readFileSync(join(ROOT, file === "LICENSE" ? LICENSE : join(PACK, file)));
		expect(createHash("sha256").update(bytes).digest("hex"), file).toBe(hash);
	}
});

it("shares no skill name with another built-in root: stock keeps one skill per name", () => {
	const elsewhere = [
		"skills",
		"pstack/skills",
		"ecc/skills",
		"formal/skills",
		"matt/skills",
		"ponytail/skills",
	].flatMap(dir => (existsSync(join(BUILTIN, dir)) ? readdirSync(join(BUILTIN, dir)) : []));
	expect(pin.curation.kept.filter(name => elsewhere.includes(name))).toEqual([]);
});

it("copies the kept skills' Markdown at the commit and refuses what the curation has not reviewed", async () => {
	const dir = mkdtempSync(join(tmpdir(), "interfaces-sync-"));
	const source = join(dir, "upstream");
	const output = join(dir, "output");
	await initRepo(source);
	const write = (file: string, text: string) => {
		mkdirSync(join(source, file, ".."), { recursive: true });
		writeFileSync(join(source, file), text);
	};
	const license = readFileSync(join(ROOT, LICENSE), "utf8").replace(/^Copyright .+$/m, "Copyright (c) 2027 Someone");
	write("LICENSE", license);
	write(".claude-plugin/plugin.json", JSON.stringify({ version: "2.0.0", license: "MIT" }));
	write("skills/better-ui/SKILL.md", "---\nname: better-ui\ndescription: Polish.\n---\n\n# Better UI\n");
	write("skills/better-ui/icons.md", "# Icons\n");
	write("skills/better-ui/agents/openai.yaml", "policy: {}\n");
	write("skills/afk/SKILL.md", "---\nname: afk\ndescription: Away.\n---\n");
	write("skills/afk/run.sh", "echo excluded skills are never read\n");
	gitSync(source, "add", "-A");
	gitSync(source, "commit", "-qm", "upstream release");
	const curation = { kept: ["better-ui"], excluded: { afk: "Autopilot" } };
	const sync = () =>
		syncInterfaces(source, output, { commit: gitSync(source, "rev-parse", "HEAD"), version: "2.0.0", curation });
	mkdirSync(join(output, "LICENSES"), { recursive: true });
	writeFileSync(join(source, "skills/better-ui/icons.md"), "uncommitted local change");
	sync();
	expect(packFiles(output)).toEqual([
		"interfaces-manifest.json",
		"skills/better-ui/SKILL.md",
		"skills/better-ui/icons.md",
	]);
	expect(readFileSync(join(output, PACK, "skills/better-ui/icons.md"), "utf8")).toBe("# Icons\n");
	expect(readFileSync(join(output, LICENSE), "utf8")).toBe(license);
	gitSync(source, "checkout", "--", ".");

	write("skills/better-ui/tokens.json", "{}");
	gitSync(source, "add", "-A");
	gitSync(source, "commit", "-qm", "a file that is not Markdown");
	expect(sync).toThrow(/unexpected file skills\/better-ui\/tokens\.json/i);
	gitSync(source, "rm", "-q", "skills/better-ui/tokens.json");
	write("skills/better-forms/SKILL.md", "---\nname: better-forms\ndescription: Forms.\n---\n");
	gitSync(source, "add", "-A");
	gitSync(source, "commit", "-qm", "a new skill");
	expect(sync).toThrow(/"better-forms" is new/);
	gitSync(source, "rm", "-rq", "skills/better-forms", "skills/afk");
	gitSync(source, "commit", "-qm", "an excluded skill leaves upstream");
	expect(sync).toThrow(/missing upstream: afk/);
});
