import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import config from "../resources/omp-builtin/ponytail/ponytail-config.json" with { type: "json" };
import { withoutGitSelectors } from "../src/shared/git-env";

const SKILLS = ["ponytail", "ponytail-audit", "ponytail-debt", "ponytail-gain", "ponytail-help", "ponytail-review"];
const ROOT = resolve(import.meta.dirname, "..");
const MIT_TERMS_SHA256 = "fe2a9817987f862eaced948f0468c7f51d2fedfc48c5c505b246a49a3870e9a5";

/** Refuses a LICENSE whose terms are not the MIT License's, word for word; the copyright line may change. */
export function assertMitLicense(license: Buffer, what: string): void {
	const terms = /^MIT License\n+Copyright [^\n]+\n+(Permission is hereby granted,[\s\S]*)$/.exec(
		license.toString().replace(/\r\n/g, "\n"),
	)?.[1];
	if (!terms || createHash("sha256").update(terms.trim().replace(/\s+/g, " ")).digest("hex") !== MIT_TERMS_SHA256) {
		throw new Error(`${what} license terms changed; review before distributing`);
	}
}

export function syncPonytail(
	source: string,
	root: string,
	{ commit, version }: Pick<typeof config, "commit" | "version">,
): void {
	if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("Expected a full Ponytail commit SHA");
	const opts = { cwd: source, env: withoutGitSelectors(process.env) };
	const skills = SKILLS.map(name => `skills/${name}/SKILL.md`);
	// skills/plugin.json is present upstream but never loaded or copied.
	const inputs = ["LICENSE", "package.json", "skills/plugin.json", ...skills].sort();
	const tree = execFileSync(
		"git",
		["ls-tree", "-rz", "--format=%(objectmode) %(path)", commit, "--", "skills", "LICENSE", "package.json"],
		opts,
	)
		.toString()
		.split("\0")
		.filter(Boolean)
		.sort();
	if (tree.join("\n") !== inputs.map(file => `100644 ${file}`).join("\n")) {
		throw new Error(
			`Unexpected Ponytail source tree at ${commit}; review its files and modes: ${JSON.stringify(tree)}`,
		);
	}
	const blob = (file: string) => execFileSync("git", ["cat-file", "blob", `${commit}:${file}`], opts);
	const pkg = JSON.parse(blob("package.json").toString());
	if (pkg.name !== "@dietrichgebert/ponytail" || pkg.version !== version || pkg.license !== "MIT") {
		throw new Error(`Expected @dietrichgebert/ponytail ${version} under MIT`);
	}
	const license = blob("LICENSE");
	assertMitLicense(license, "Ponytail");
	const files = new Map([["LICENSE", license], ...skills.map(file => [file, blob(file)] as const)]);
	const pack = join(root, "resources/omp-builtin/ponytail");
	const hashes: Record<string, string> = {};
	for (const [file, bytes] of files) {
		const dest = file === "LICENSE" ? join(root, "LICENSES/MIT-ponytail.txt") : join(pack, file);
		mkdirSync(dirname(dest), { recursive: true });
		writeFileSync(dest, bytes);
		hashes[file] = createHash("sha256").update(bytes).digest("hex");
	}
	writeFileSync(
		join(pack, "ponytail-manifest.json"),
		`${JSON.stringify({ commit, version, files: hashes }, null, "\t")}\n`,
	);
}

if (import.meta.main) {
	if (process.argv.includes("--check")) {
		execFileSync("bun", [join(ROOT, "scripts/skill-packs.ts"), "check", "ponytail"], { stdio: "inherit" });
	} else {
		const local = process.env.PONYTAIL_SRC;
		const source = local || mkdtempSync(join(tmpdir(), "ponytail-src-"));
		try {
			if (!local)
				execFileSync(
					"git",
					["clone", "--bare", "--filter=blob:none", `https://github.com/${config.repo}`, source],
					{ env: withoutGitSelectors(process.env) },
				);
			syncPonytail(source, ROOT, config);
			console.log(`Vendored ${SKILLS.length} Ponytail skills from ${config.version} (${config.commit})`);
		} finally {
			if (!local) rmSync(source, { recursive: true, force: true });
		}
	}
}
