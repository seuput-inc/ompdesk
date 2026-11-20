import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { expect, it } from "vitest";
import pin from "../../../resources/omp-builtin/ponytail/ponytail-config.json";
import manifest from "../../../resources/omp-builtin/ponytail/ponytail-manifest.json";
import { syncPonytail } from "../../../scripts/sync-ponytail";
import { gitSync, initRepo } from "../local/git/test-repos";

const ROOT = join(__dirname, "../../..");
const PACK = "resources/omp-builtin/ponytail";
const LICENSE = "LICENSES/MIT-ponytail.txt";
const documents = [
	"ponytail",
	"ponytail-review",
	"ponytail-help",
	"ponytail-audit",
	"ponytail-gain",
	"ponytail-debt",
].map(name => `skills/${name}/SKILL.md`);

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

it("ships exactly six stock-readable documents, with the bytes and license recorded at the pin", () => {
	expect(pin.repo).toBe("DietrichGebert/ponytail");
	expect(pin.commit).toMatch(/^[0-9a-f]{40}$/);
	expect(manifest).toMatchObject({ commit: pin.commit, version: pin.version });
	expect(packFiles(ROOT)).toEqual(["ponytail-config.json", "ponytail-manifest.json", ...documents].sort());
	expect(Object.keys(manifest.files).sort()).toEqual(["LICENSE", ...documents].sort());
	for (const [file, hash] of Object.entries(manifest.files)) {
		const bytes = readFileSync(join(ROOT, file === "LICENSE" ? LICENSE : join(PACK, file)));
		expect(createHash("sha256").update(bytes).digest("hex"), file).toBe(hash);
	}
});

it("copies only approved blobs at the commit and refuses a new upstream skill file", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ponytail-sync-"));
	const source = join(dir, "upstream");
	const output = join(dir, "output");
	await initRepo(source);
	cpSync(join(ROOT, PACK, "skills"), join(source, "skills"), { recursive: true });
	writeFileSync(join(source, "skills/plugin.json"), "{}\n");
	writeFileSync(
		join(source, "package.json"),
		JSON.stringify({ name: "@dietrichgebert/ponytail", version: "6.0.0", license: "MIT" }),
	);
	const license = readFileSync(join(ROOT, LICENSE), "utf8").replace(
		/^Copyright .+$/m,
		"Copyright (c) 2027 DietrichGebert",
	);
	writeFileSync(join(source, "LICENSE"), license);
	mkdirSync(join(source, "hooks"));
	writeFileSync(join(source, "hooks/band.js"), 'throw new Error("not part of this pack");');
	gitSync(source, "add", "--", "skills", "hooks", "package.json", "LICENSE");
	gitSync(source, "commit", "-qm", "upstream release");
	const commit = gitSync(source, "rev-parse", "HEAD");
	const file = "skills/ponytail/SKILL.md";
	const committed = readFileSync(join(source, file));
	writeFileSync(join(source, file), "uncommitted local change");
	syncPonytail(source, output, { commit, version: "6.0.0" });
	expect(packFiles(output)).toEqual(["ponytail-manifest.json", ...documents].sort());
	expect(readFileSync(join(output, PACK, file))).toEqual(committed);
	expect(readFileSync(join(output, LICENSE), "utf8")).toBe(license);
	writeFileSync(join(source, "skills/ponytail/band.js"), "");
	gitSync(source, "add", "--", "skills/ponytail/band.js");
	gitSync(source, "commit", "-qm", "add an unreviewed skill script");
	expect(() =>
		syncPonytail(source, output, { commit: gitSync(source, "rev-parse", "HEAD"), version: "6.0.0" }),
	).toThrow(/unexpected ponytail source tree/i);
});
