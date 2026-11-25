import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { clearAgentWorktrees, listAgentWorktrees } from "./agent-worktrees";
import { INSTALLED_OMP } from "./test-bridge-probe";
import { RM_TEMP, writeFakeOmp } from "./test-fake-omp";

function fixture() {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "ompdesk-worktree cli-")));
	onTestFinished(() => rmSync(home, RM_TEMP));
	const cwd = join(home, "working folder");
	const tmp = join(home, "tmp");
	const wt = join(home, "managed trees");
	const agent = join(home, ".omp", "agent");
	for (const folder of [cwd, tmp, wt, agent]) mkdirSync(folder, { recursive: true });
	const env: NodeJS.ProcessEnv = {
		HOME: home,
		USERPROFILE: home,
		APPDATA: join(home, "AppData", "Roaming"),
		LOCALAPPDATA: join(home, "AppData", "Local"),
		PI_CONFIG_DIR: ".omp",
		PI_CODING_AGENT_DIR: agent,
		OMP_WORKTREE_DIR: wt,
		PATH: [dirname(INSTALLED_OMP), process.env.PATH].filter(Boolean).join(delimiter),
		SystemRoot: process.env.SystemRoot,
		ComSpec: process.env.ComSpec,
		PATHEXT: process.env.PATHEXT,
		TMPDIR: tmp,
		TEMP: tmp,
		TMP: tmp,
		BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
		OTEL_SDK_DISABLED: "true",
	};
	return { home, cwd, wt, env };
}

describe("agent worktree commands", () => {
	it("runs list and orphan-only clear once each in the supplied cwd with plain output and closed stdin", async () => {
		const { home, cwd, env } = fixture();
		const calls = join(home, "calls.jsonl");
		const bin = await writeFakeOmp(
			home,
			`import { appendFileSync } from "node:fs";
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({
  argv, cwd: process.cwd(), home: process.env.HOME, stamp: process.env.CALL_STAMP,
  color: [process.env.NO_COLOR, process.env.FORCE_COLOR], stdin: await Bun.stdin.text()
}) + "\\n");
process.stdout.write(process.env.STOCK_OUTPUT);`,
		);
		const launch = { bin, env: { ...env, NO_COLOR: "0", FORCE_COLOR: "1", CALL_STAMP: "first", STOCK_OUTPUT: "" } };
		launch.env.STOCK_OUTPUT = JSON.stringify([
			{ path: "/w/pr", kind: "pr-checkout", parentRepo: "/repo", branch: "pr-12", ignored: true },
			{ path: "/w/task", kind: "task-isolation", orphanReason: "owner gone", branch: "" },
			{ path: "/w/empty", kind: "empty", parentRepo: 42 },
			{ path: "/w/stray", kind: "stray" },
			{ path: "/w/x", kind: "unknown-kind" },
			{ kind: "stray" },
			null,
		]);
		await expect(listAgentWorktrees(launch, cwd)).resolves.toEqual({
			entries: [
				{ path: "/w/pr", kind: "pr-checkout", parentRepo: "/repo", branch: "pr-12" },
				{ path: "/w/task", kind: "task-isolation", orphanReason: "owner gone" },
				{ path: "/w/empty", kind: "empty" },
				{ path: "/w/stray", kind: "stray" },
			],
		});
		launch.env.CALL_STAMP = "second";
		launch.env.STOCK_OUTPUT = JSON.stringify({
			removed: 1,
			failed: 1,
			results: [
				{ path: "/w/a", ok: true, error: "", ignored: true },
				{ path: "/w/b", ok: false, error: "EBUSY" },
				{ path: "/w/c", ok: "false" },
			],
		});
		await expect(clearAgentWorktrees(launch, cwd)).resolves.toEqual({
			removed: 1,
			failed: 1,
			results: [
				{ path: "/w/a", ok: true },
				{ path: "/w/b", ok: false, error: "EBUSY" },
			],
		});
		const common = { cwd, home, color: ["1", "0"], stdin: "" };
		const lines = readFileSync(calls, "utf8").trimEnd().split("\n");
		expect(lines.map(line => JSON.parse(line))).toEqual([
			{ ...common, argv: ["worktree", "list", "--json"], stamp: "first" },
			{ ...common, argv: ["worktree", "clear", "--json"], stamp: "second" },
		]);
	});

	it("projects a stock listing larger than 4 MiB without truncating it", async () => {
		const { home, cwd, env } = fixture();
		const bin = await writeFakeOmp(
			home,
			`console.log(JSON.stringify([{ path: "/large", kind: "empty", ignored: "x".repeat(4 * 1024 * 1024) }]));`,
		);
		await expect(listAgentWorktrees({ bin, env }, cwd)).resolves.toEqual({
			entries: [{ path: "/large", kind: "empty" }],
		});
	});

	it("reports the last six lines of stderr, falling back to stdout or the exit code", async () => {
		const { home, cwd, env } = fixture();
		const bin = await writeFakeOmp(
			home,
			`process.stdout.write(process.env.OUT);
process.stderr.write(process.env.ERR);
process.exitCode = Number(process.env.STATUS);`,
		);
		const launch = { bin, env: { ...env, OUT: "[]", ERR: "noise\r\n1\r\n2\r\n3\r\n4\r\n5\r\n6\r\n", STATUS: "2" } };
		const failure = { name: "LocalCommandError", code: "worktree_cli_failed" };
		await expect(listAgentWorktrees(launch, cwd)).rejects.toMatchObject({ ...failure, message: "1\n2\n3\n4\n5\n6" });
		launch.env = { ...launch.env, OUT: "not JSON", ERR: "", STATUS: "0" };
		await expect(listAgentWorktrees(launch, cwd)).rejects.toMatchObject({ ...failure, message: "not JSON" });
		launch.env.OUT = "[]";
		await expect(clearAgentWorktrees(launch, cwd)).rejects.toMatchObject({ ...failure, message: "[]" });
		launch.env = { ...launch.env, OUT: "", STATUS: "7" };
		await expect(clearAgentWorktrees(launch, cwd)).rejects.toMatchObject({
			...failure,
			message: "omp worktree clear exited with code 7",
		});
	});

	it("keeps a launch failure distinct from a stock refusal", async () => {
		const { home, cwd, env } = fixture();
		const request = listAgentWorktrees({ bin: join(home, "missing-omp.exe"), env }, cwd);
		await expect(request).rejects.toThrow();
		await expect(request).rejects.not.toMatchObject({ code: "worktree_cli_failed" });
	});
});

it.skipIf(!existsSync(INSTALLED_OMP))(
	"installed stock lists and removes only the isolated orphan",
	async () => {
		const { cwd, wt, env } = fixture();
		const orphan = join(wt, "isolated-empty");
		mkdirSync(orphan);
		const launch = { bin: INSTALLED_OMP, env };

		// Refuse to call stock's destructive command unless its entire list matches our fixture.
		await expect(listAgentWorktrees(launch, cwd)).resolves.toEqual({
			entries: [{ path: orphan, kind: "empty", orphanReason: "empty directory" }],
		});
		await expect(clearAgentWorktrees(launch, cwd)).resolves.toEqual({
			removed: 1,
			failed: 0,
			results: [{ path: orphan, ok: true }],
		});
		expect(existsSync(orphan)).toBe(false);
		await expect(listAgentWorktrees(launch, cwd)).resolves.toEqual({ entries: [] });
		await expect(clearAgentWorktrees(launch, cwd)).resolves.toEqual({ removed: 0, failed: 0, results: [] });
	},
	60_000,
);
