/**
 * Supply-chain pins. `bunfig.toml` delays brand-new dependency versions, and every
 * workflow installs one exact Bun, so neither a hijacked release nor a Bun that
 * changed overnight reaches CI or a release build unreviewed.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { MIN_OMP_VERSION } from "./omp-runtime";

const ROOT = path.resolve(__dirname, "../..");
const WORKFLOWS = path.join(ROOT, ".github/workflows");
const MIN_RELEASE_AGE_SECONDS = 3 * 24 * 60 * 60;

interface Workflow {
	jobs?: Record<string, { steps?: { uses?: string; with?: Record<string, unknown> }[] }>;
}

function setupBunVersions(): { file: string; job: string; version: unknown }[] {
	const found: { file: string; job: string; version: unknown }[] = [];
	for (const file of fs.readdirSync(WORKFLOWS).filter(name => /\.ya?ml$/.test(name))) {
		const workflow = parse(fs.readFileSync(path.join(WORKFLOWS, file), "utf8")) as Workflow;
		for (const [job, { steps = [] }] of Object.entries(workflow.jobs ?? {})) {
			for (const step of steps) {
				if (step.uses?.startsWith("oven-sh/setup-bun@"))
					found.push({ file, job, version: step.with?.["bun-version"] });
			}
		}
	}
	return found;
}

describe("supply chain", () => {
	it("bunfig.toml holds new package versions back for at least three days", () => {
		const toml = fs.readFileSync(path.join(ROOT, "bunfig.toml"), "utf8");
		const install = /^\[install\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(toml)?.[1] ?? "";
		const age = /^minimumReleaseAge\s*=\s*(\d+)\s*(?:#.*)?$/m.exec(install);
		expect(age, "[install] minimumReleaseAge (seconds) is missing").not.toBeNull();
		expect(Number(age?.[1])).toBeGreaterThanOrEqual(MIN_RELEASE_AGE_SECONDS);
	});

	it("every workflow job that sets up Bun pins one exact version, never latest", () => {
		const uses = setupBunVersions();
		expect(uses.length).toBeGreaterThan(0);
		for (const { file, job, version } of uses) {
			expect(version, `${file} › ${job}`).toMatch(/^\d+\.\d+\.\d+$/);
		}
		expect(new Set(uses.map(use => use.version)).size, "workflows pin different Bun versions").toBe(1);
	});

	it("workflows install omp only through install-omp, and only omp-latest asks for the latest", () => {
		const latest: string[] = [];
		let uses = 0;
		for (const file of fs.readdirSync(WORKFLOWS).filter(name => /\.ya?ml$/.test(name))) {
			const text = fs.readFileSync(path.join(WORKFLOWS, file), "utf8");
			expect(text, `${file} installs omp itself`).not.toMatch(
				/bun (?:install|add) -g\b[^\n]*@oh-my-pi\/pi-coding-agent/,
			);
			const workflow = parse(text) as Workflow;
			for (const [job, { steps = [] }] of Object.entries(workflow.jobs ?? {})) {
				for (const step of steps) {
					if (step.uses !== "./.github/actions/install-omp") continue;
					uses++;
					if (step.with?.version === "latest") latest.push(file);
					else expect(step.with?.version ?? "tested", `${file} › ${job}`).toBe("tested");
				}
			}
		}
		expect(uses).toBeGreaterThan(0);
		expect([...new Set(latest)]).toEqual(["omp-latest.yml"]);
	});

	it("the tested omp is one exact version the app accepts, and install-omp installs exactly it", () => {
		const tested = JSON.parse(fs.readFileSync(path.join(ROOT, "src/shared/omp-tested.json"), "utf8")) as {
			version: string;
		};
		expect(tested.version).toMatch(/^\d+\.\d+\.\d+$/);
		const parts = (version: string) => version.split(".").map(Number);
		const [a, b] = [parts(tested.version), parts(MIN_OMP_VERSION)];
		const order = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
		expect(order, `tested ${tested.version} is older than MIN_OMP_VERSION ${MIN_OMP_VERSION}`).toBeGreaterThanOrEqual(
			0,
		);
		const action = fs.readFileSync(path.join(ROOT, ".github/actions/install-omp/action.yml"), "utf8");
		expect(action).toContain("@oh-my-pi/pi-coding-agent@$(jq -er .version src/shared/omp-tested.json)");
		expect(action).toContain("--minimum-release-age 0");
	});
});
