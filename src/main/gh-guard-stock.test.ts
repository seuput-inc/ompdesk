import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type Frame, fakeAgent, type Omp, sse, startOmp, startProvider, toolCall } from "./bridge-todo-stock-rig";
import { INSTALLED_OMP as omp } from "./test-bridge-probe";

/**
 * The gh guard (resources/gui-bridge/gh-guard.ts) in a stock omp session, as main launches one: the launchers' folder
 * first on PATH, a fake gh after it that counts its calls and serves `rate_limit`, run and job facts and logs. No
 * GitHub request is made.
 */

const GUARD_DIR = resolve("resources/gui-bridge/gh-bin");
const RUN = "44587803757";

/** A fake gh: records each call's arguments, answers from files in its folder. */
const FAKE_GH = `#!/bin/sh
echo "$*" >> "$FAKE_GH_DIR/calls.log"
if [ "$1" = api ]; then
	case "$2" in
	rate_limit) cat "$FAKE_GH_DIR/rate.json"; exit 0 ;;
	*/actions/runs/*) cat "$FAKE_GH_DIR/run-\${2##*/}.tsv"; exit 0 ;;
	esac
fi
if [ "$1 $2" = "run list" ]; then echo "RUNS LISTED"; exit 0; fi
if [ "$1 $2" = "run watch" ]; then echo "WATCHED $*"; exit 0; fi
if [ "$1 $2" = "run view" ]; then
	attempt=none
	while [ $# -gt 0 ]; do
		if [ "$1" = --attempt ]; then attempt=$2; fi
		shift
	done
	printf 'build\\tRun tests\\tRESULT %s of attempt %s\\n' "$(cat "$FAKE_GH_DIR/result-$attempt" 2>/dev/null)" "$attempt"
	exit 0
fi
echo "unexpected: $*" >&2
exit 1
`;

interface Rig {
	fake: string;
	env: Record<string, string>;
	calls(): string[];
}

function rig(core: number): Rig {
	const root = mkdtempSync(join(tmpdir(), "ompdesk-gh-guard-"));
	const fake = join(root, "fake");
	mkdirSync(fake);
	writeFileSync(join(fake, "gh"), FAKE_GH);
	chmodSync(join(fake, "gh"), 0o755);
	const reset = Math.floor(Date.now() / 1000) + 1800;
	writeFileSync(
		join(fake, "rate.json"),
		JSON.stringify({
			resources: {
				core: { limit: 5000, remaining: core, reset },
				graphql: { limit: 5000, remaining: 4638, reset },
			},
		}),
	);
	// Run 44587803757 was rerun: attempt 1 failed, attempt 2 (the latest, finished) is green.
	writeFileSync(join(fake, `run-${RUN}.tsv`), "2\tcompleted\tseuput-inc/ompdesk\n");
	writeFileSync(join(fake, "result-1"), "FAILED");
	writeFileSync(join(fake, "result-2"), "GREEN");
	const scratch = join(root, "scratch");
	mkdirSync(scratch);
	return {
		fake,
		env: {
			PATH: [GUARD_DIR, fake, process.env.PATH ?? ""].join(delimiter),
			OMP_GUI_GH_GUARD: GUARD_DIR,
			OMP_GUI_SCRATCH: scratch,
			OMPDESK_GH_BUDGET_DIR: join(root, "budget"),
			FAKE_GH_DIR: fake,
			// What main gives a tab's omp: the person's own commands carry no tool call id.
			PI_TOOL_CALL_ID: "",
		},
		calls: () => {
			const log = join(fake, "calls.log");
			return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
		},
	};
}

/** Starts a session whose model makes `script`'s tool calls in order; `seen[n]` is the fake's calls when step n was asked. */
async function session(
	setup: Rig,
	script: unknown[][],
): Promise<{ session: Omp; seen: number[]; results(): { text: string; isError: boolean }[] }> {
	const seen: number[] = [];
	const provider = await startProvider(step => {
		seen[step] = setup.calls().length;
		return step <= script.length ? sse(script[step - 1], "tool_calls") : sse([{ content: "DONE" }], "stop");
	});
	const started = await startOmp({
		...fakeAgent(provider.url),
		model: "fake/m1",
		bridge: resolve("resources/gui-bridge/index.ts"),
		env: setup.env,
	});
	return {
		session: started,
		seen,
		results: () =>
			started.frames
				.filter((frame: Frame) => frame.type === "tool_execution_end")
				.map(frame => {
					const result = frame.result as { content?: { text?: string }[] } | undefined;
					return {
						text: (result?.content ?? []).map(part => part.text ?? "").join("\n"),
						isError: frame.isError === true,
					};
				}),
	};
}

const views = (calls: string[]) => calls.filter(call => call.startsWith("run view"));

describe.skipIf(!existsSync(omp) || process.platform === "win32")("gh guard, on stock omp", () => {
	it("serves a finished attempt's log from the cache, by attempt, and slows a watch to a minute", async () => {
		const setup = rig(4000);
		const {
			session: s,
			seen,
			results,
		} = await session(setup, [
			toolCall("bash", { command: `gh run view ${RUN} --log-failed | grep RESULT` }),
			toolCall("bash", { command: `gh run view ${RUN} --log-failed` }),
			toolCall("bash", { command: `gh run view ${RUN} --log-failed --attempt 1` }),
			toolCall("bash", { command: `gh run view ${RUN} --log-failed --attempt 1` }),
			toolCall("bash", { command: `gh run watch ${RUN}`, async: false }),
			toolCall("bash", { command: `gh run watch ${RUN} -i 120` }),
		]);
		await s.turn("Read the run's failed jobs");
		const out = results();
		expect(out).toHaveLength(6);
		// No --attempt: the latest attempt (2, green), fetched once and then from the cache.
		expect(out[0]?.text).toContain("RESULT GREEN of attempt 2");
		expect(out[1]?.text).toMatch(/^\[OMPdesk gh log cache\] run 44587803757 attempt 2 \(seuput-inc\/ompdesk\)/);
		expect(out[1]?.text).toContain("RESULT GREEN of attempt 2");
		// --attempt 1: the first failure, kept beside it.
		expect(out[2]?.text).toContain("attempt 1");
		expect(out[2]?.text).toContain("RESULT FAILED of attempt 1");
		expect(out[3]?.text).toContain("RESULT FAILED of attempt 1");
		const calls = setup.calls();
		expect(views(calls)).toEqual([
			`run view ${RUN} --log-failed --attempt 2`,
			`run view ${RUN} --log-failed --attempt 1`,
		]);
		// The fourth fetch named its attempt and was cached: GitHub was not asked at all.
		expect(seen[5]).toBe(seen[4]);
		expect(calls.filter(call => call.startsWith("run watch"))).toEqual([
			`run watch ${RUN} --interval 60`,
			`run watch ${RUN} -i 120`,
		]);
	}, 180_000);

	it("refuses wide reads below the floor as an error naming what is left, never the narrow read or the person's command", async () => {
		const setup = rig(1200);
		const { session: s, results } = await session(setup, [
			toolCall("bash", { command: "gh run list --limit 50 | head -3" }),
			toolCall("bash", { command: `gh run watch ${RUN}` }),
			toolCall("bash", { command: `gh run view ${RUN} --log-failed | grep RESULT` }),
		]);
		await s.turn("Look at the runs");
		const out = results();
		expect(out).toHaveLength(3);
		for (const refused of [out[0], out[1]]) {
			// An error, even through a pipe whose exit status is head's.
			expect(refused?.isError).toBe(true);
			expect(refused?.text).toContain("OMPdesk refused");
			expect(refused?.text).toContain("core 1200 of 5000 left, resets");
			expect(refused?.text).toContain("graphql 4638 of 5000 left");
			expect(refused?.text).toContain("--log-failed");
		}
		expect(out[2]?.isError).toBe(false);
		expect(out[2]?.text).toContain("RESULT GREEN of attempt 2");
		expect(setup.calls().filter(call => call.startsWith("run list") || call.startsWith("run watch"))).toEqual([]);
		// One reading of the quota served every check of the minute.
		expect(setup.calls().filter(call => call === "api rate_limit")).toHaveLength(1);
		// The person's own command (the composer's `!`) is never refused.
		const typed = await s.send({ type: "bash", command: "gh run list --limit 50" });
		expect(JSON.stringify(typed)).toContain("RUNS LISTED");
		expect(setup.calls()).toContain("run list --limit 50");
	}, 180_000);
});
