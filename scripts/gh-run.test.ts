import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { QUOTA_FLOOR } from "../resources/gui-bridge/gh-guard-core";
import { wideReadRefusal } from "./gh-run";

describe("a script's wide gh read below the quota floor", () => {
	const made: string[] = [];
	afterEach(() => {
		for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	/** An agent's environment whose computer-wide reading (fresh, so no gh runs) leaves `core` requests. */
	const agentWith = (core: number): NodeJS.ProcessEnv => {
		const dir = mkdtempSync(join(tmpdir(), "omp-gh-run-"));
		made.push(dir);
		const reset = Math.floor(Date.now() / 1000) + 3600;
		writeFileSync(
			join(dir, "rate-limit.json"),
			JSON.stringify({
				at: Date.now(),
				core: { limit: 5000, remaining: core, reset },
				graphql: { limit: 5000, remaining: 5000, reset },
			}),
		);
		return { OMPDESK_GH_BUDGET_DIR: dir, PI_TOOL_CALL_ID: "call-1" };
	};

	it("is refused with what is left and when it resets; narrow reads, dispatches and a person's reads run", () => {
		const low = agentWith(QUOTA_FLOOR - 1);
		const refused = wideReadRefusal(["run", "list", "--limit", "5"], low);
		expect(refused).toContain(`core ${QUOTA_FLOOR - 1} of 5000 left, resets`);
		expect(wideReadRefusal(["run", "watch", "42", "--interval", "120"], low)).toBeDefined();
		expect(wideReadRefusal(["api", "--paginate", "repos/o/r/actions/runs"], low)).toBeDefined();
		expect(wideReadRefusal(["run", "view", "42", "--json", "status,conclusion,jobs"], low)).toBeUndefined();
		expect(wideReadRefusal(["workflow", "run", "ci.yml", "--ref", "b"], low)).toBeUndefined();
		expect(wideReadRefusal(["run", "list"], { ...low, PI_TOOL_CALL_ID: "" })).toBeUndefined();
		expect(wideReadRefusal(["run", "list"], agentWith(QUOTA_FLOOR))).toBeUndefined();
	});
});
