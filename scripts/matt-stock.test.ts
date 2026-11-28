import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import config from "../resources/omp-builtin/matt/matt-config.json";
import { stockFixtureEnv, stockSource, stopOmpDaemon } from "../src/main/test-bridge-probe";
import { removeWhenFree } from "../src/main/test-folders";

interface Probe {
	usedTokens: number;
	skills: { name: string; path: string; hidden: boolean }[];
	read: Record<string, string>;
}

const builtin = path.join(__dirname, "../resources/omp-builtin");
const matt = path.join(builtin, "matt");
const roots = [
	builtin,
	...["pstack", "ecc", "formal", "interfaces", "matt", "ponytail"].map(name => path.join(builtin, name)),
];
const sdk = stockSource("pi-coding-agent", "sdk.ts");
const url = "skill://wait-what";

function probe(home: string, mounted: string[]): Probe {
	const cwd = path.join(home, "project");
	mkdirSync(cwd, { recursive: true });
	const output = execFileSync(
		"bun",
		[path.join(__dirname, "../src/main/formal/stock-probe.ts"), path.resolve(sdk!, "../.."), cwd, ...mounted],
		{
			cwd,
			env: { ...stockFixtureEnv(home), STOCK_PROBE_READ: url },
			encoding: "utf8",
			timeout: 90_000,
		},
	);
	return JSON.parse(output.trim().split("\n").at(-1)!);
}

describe.skipIf(!sdk)("Matt skills on installed stock omp", () => {
	let home: string;
	function fixture() {
		home = realpathSync(mkdtempSync(path.join(tmpdir(), "omp-matt-stock-")));
		mkdirSync(path.join(home, "agent"));
		return home;
	}
	afterEach(async () => {
		stopOmpDaemon(home, stockFixtureEnv(home));
		await removeWhenFree(home);
	});

	it("loads the kept names and upstream visibility within the prompt budget", () => {
		const home = fixture();
		const before = probe(
			home,
			roots.filter(root => root !== matt),
		);
		const after = probe(home, roots);
		const ours = after.skills.filter(skill => skill.path.startsWith(matt + path.sep));
		expect(ours.map(skill => skill.name).sort()).toEqual([...config.curation.kept].sort());
		expect(
			ours
				.filter(skill => skill.hidden)
				.map(skill => skill.name)
				.sort(),
		).toEqual([
			"ask-matt",
			"grill-with-docs",
			"setup-matt-pocock-skills",
			"to-questionnaire",
			"to-spec",
			"to-tickets",
			"wait-what",
			"wayfinder",
		]);
		expect(after.read[url]).toContain("name: wait-what");
		const delta = after.usedTokens - before.usedTokens;
		console.log(`Matt prompt tokens: before=${before.usedTokens} after=${after.usedTokens} delta=${delta}`);
		expect(delta).toBeGreaterThan(0);
		expect(delta).toBeLessThan(300);
	}, 180_000);

	it("deduplicates an identical user skill and preserves both versions of a differing skill", () => {
		const home = fixture();
		const userSkills = path.join(home, "agent/skills");
		for (const name of ["wait-what", "grilling"]) mkdirSync(path.join(userSkills, name), { recursive: true });
		copyFileSync(path.join(matt, "skills/wait-what/SKILL.md"), path.join(userSkills, "wait-what/SKILL.md"));
		const userGrilling = path.join(userSkills, "grilling/SKILL.md");
		writeFileSync(
			userGrilling,
			"---\nname: grilling\ndescription: User recipe questions.\n---\nAsk about the recipe.\n",
		);
		const { skills } = probe(home, roots);
		expect(
			skills.filter(skill => path.basename(path.dirname(skill.path)) === "wait-what").map(skill => skill.name),
		).toEqual(["wait-what"]);
		expect(
			skills
				.filter(skill => path.basename(path.dirname(skill.path)) === "grilling")
				.map(({ name, path }) => ({ name, path })),
		).toEqual(
			expect.arrayContaining([
				{ name: "grilling", path: userGrilling },
				{ name: "matt/grilling", path: path.join(matt, "skills/grilling/SKILL.md") },
			]),
		);
	}, 90_000);
});
