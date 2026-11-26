import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { localCargoRefusal } from "./vitest-native";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "vitest-native-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A local computer whose heavy pool holds `slots` commands; the pool is the test's own folder. */
function computer(slots: number, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		OMPDESK_HEAVY_DIR: path.join(dir, "heavy"),
		OMPDESK_HEAVY_SLOTS: String(slots),
	};
	delete env.GITHUB_ACTIONS;
	delete env.OMPDESK_NO_LOCAL_CARGO;
	return { ...env, ...extra };
}

const STALE = "resources/ompdesk-bin/x/ompdesk.build.json is missing.";

it("refuses a stale build on a one-slot computer and points at CI", async () => {
	const line = await localCargoRefusal(STALE, computer(1));
	expect(line).toContain(STALE);
	expect(line).toContain("bun scripts/ci-run.ts ci --ref <branch> -f batch=true");
	expect(line).not.toContain("\n");
});

it("builds on a computer that holds more than the test run, and on GitHub's runners", async () => {
	expect(await localCargoRefusal(STALE, computer(3))).toBeUndefined();
	expect(await localCargoRefusal(STALE, computer(1, { GITHUB_ACTIONS: "true" }))).toBeUndefined();
});

it("refuses on any computer that sets OMPDESK_NO_LOCAL_CARGO=1", async () => {
	expect(await localCargoRefusal(STALE, computer(7, { OMPDESK_NO_LOCAL_CARGO: "1" }))).toContain(
		"OMPDESK_NO_LOCAL_CARGO=1",
	);
});
