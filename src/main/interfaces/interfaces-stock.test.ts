/**
 * The interface skills on the installed omp (skipped without one): a real session built in a private HOME and agent
 * dir through `formal/stock-probe.ts`, with every built-in skill root a spawn mounts with every switch on. Pins what
 * the curation promises:
 * - every kept skill loads from the pack under its own name: none shadowed or renamed by another root's skill;
 * - upstream's visibility holds: the domain skills, better-interface and build-design are listed, the procedure skills
 *   are hidden and still read through `skill://`;
 * - the pack adds a bounded number of prompt tokens;
 * - `/skill:state-machine`, rendered as stock sends it, does not set off the formal-verification hint; a race named in
 *   the person's own words still does.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isFormalRequest } from "../../../resources/gui-bridge/modes/formal-hint-core";
import config from "../../../resources/omp-builtin/interfaces/interfaces-config.json";
import { ompPackageRoot, systemOmp } from "../omp-runtime";
import { stockFixtureEnv, stopOmpDaemon } from "../test-bridge-probe";
import { removeWhenFree } from "../test-folders";

interface Probe {
	usedTokens: number;
	skills: { name: string; path: string; hidden: boolean }[];
	read: Record<string, string>;
	invoked: string[];
}

const BUILTIN = path.join(__dirname, "../../../resources/omp-builtin");
const PACK = path.join(BUILTIN, "interfaces");
const READ = ["skill://better-interface", "skill://interface-review/scope-resolution.md"];
const stock = await systemOmp();
const packageRoot = stock.ok ? ompPackageRoot(stock.runtime.bin) : null;
const home = mkdtempSync(path.join(tmpdir(), "omp-interfaces-stock-"));
const env = {
	...stockFixtureEnv(home),
	STOCK_PROBE_READ: READ.join(","),
	STOCK_PROBE_INVOKE: JSON.stringify([
		["state-machine", ""],
		["state-machine", "the checkout card"],
		["state-machine", "fix the race on submit"],
	]),
};

function probe(roots: string[]): Probe {
	const cwd = path.join(home, "project");
	mkdirSync(path.join(home, "agent"), { recursive: true });
	mkdirSync(cwd, { recursive: true });
	const out = execFileSync(
		"bun",
		[path.join(__dirname, "../formal/stock-probe.ts"), packageRoot ?? "", cwd, ...roots],
		{ cwd, encoding: "utf8", env, timeout: 90_000 },
	);
	return JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as Probe;
}

afterAll(async () => {
	if (packageRoot) stopOmpDaemon(home, env);
	await removeWhenFree(home);
});

describe.skipIf(!packageRoot)("the interface skills on the installed omp", () => {
	// The directory roots `sidecar-factory.ts` mounts with every switch on (Ponytail's skills sit in its folder).
	const roots = ["skills", "pstack", "ecc", "formal", "interfaces", "matt", "ponytail"].map(name =>
		name === "skills" ? BUILTIN : path.join(BUILTIN, name),
	);
	const without = packageRoot ? probe(roots.filter(root => root !== PACK)) : undefined;
	const all = packageRoot ? probe(roots) : undefined;
	const ours = all?.skills.filter(skill => skill.path.startsWith(`${PACK}${path.sep}`)) ?? [];

	it("loads every kept skill from the pack under its own name, beside every other built-in root", () => {
		expect(ours.map(skill => skill.name).sort()).toEqual([...config.curation.kept].sort());
	});

	it("keeps upstream's visibility: domain skills listed, procedures hidden yet readable", () => {
		expect(ours.filter(skill => !skill.hidden).map(skill => skill.name)).toEqual(
			expect.arrayContaining(["better-interface", "better-accessibility", "better-ui", "build-design"]),
		);
		expect(
			ours
				.filter(skill => skill.hidden)
				.map(skill => skill.name)
				.sort(),
		).toEqual(["break", "explain-interface", "interface-review", "state-machine", "variant"].sort());
		expect(all?.read[READ[0]]).toContain("name: better-interface");
		expect(all?.read[READ[1]]).not.toMatch(/^error/);
	});

	it("adds a bounded number of prompt tokens", () => {
		const added = (all?.usedTokens ?? 0) - (without?.usedTokens ?? 0);
		expect(added).toBeGreaterThan(0);
		expect(added).toBeLessThan(300);
	});

	it("reads a /skill:state-machine turn as a UI request, not a formal-verification one", () => {
		const [bare, card, race] = all?.invoked ?? [];
		expect(bare).toContain("# State machine");
		expect(isFormalRequest(bare)).toBe(false);
		expect(isFormalRequest(card)).toBe(false);
		expect(isFormalRequest(race)).toBe(true);
	});
});
