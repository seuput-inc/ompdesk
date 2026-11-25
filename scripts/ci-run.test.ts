import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { asksForMac, parseArgs, refAllowed } from "./ci-run";

describe("ci-run arguments", () => {
	it("reads the workflow, the ref and every -f field", () => {
		expect(parseArgs(["ci.yml", "--ref", "feat/x", "-f", "batch=true", "-f", "win_e2e_grep=@smoke a=b"])).toEqual({
			workflow: "ci",
			ref: "feat/x",
			inputs: { batch: "true", win_e2e_grep: "@smoke a=b" },
			dryRun: false,
		});
	});

	it("refuses a workflow it does not know and a field without a value", () => {
		expect(parseArgs(["release"])).toContain("workflow must be one of");
		expect(parseArgs(["ci", "-f", "batch"])).toContain("key=value");
		expect(parseArgs(["ci", "--nope"])).toContain("unknown argument");
	});

	it("knows which dispatches ask for a macOS runner", () => {
		expect(asksForMac("ci", { batch: "true" })).toBe(false);
		expect(asksForMac("ci", { mac: "true" })).toBe(true);
		expect(asksForMac("ci", { e2e: "true" })).toBe(false);
		expect(asksForMac("e2e-nightly", {})).toBe(false);
		expect(asksForMac("flake-probe", { os: "windows" })).toBe(false);
		expect(asksForMac("flake-probe", {})).toBe(true);
		expect(asksForMac("flake-probe", { spec: "src/a.test.ts", os: "all" })).toBe(true);
		expect(asksForMac("flake-probe", { spec: "e2e/a.e2e.ts", os: "all" })).toBe(false);
		expect(asksForMac("flake-probe", { spec: "e2e/a.e2e.ts", os: "macos" })).toBe(true);
		expect(asksForMac("formal", {})).toBe(false);
	});
});

describe("ci-run admission", () => {
	it("lets main and the listed branches ask for macOS, by exact name", () => {
		expect(refAllowed("main", "")).toBe(true);
		expect(refAllowed("a/b", "a/b c")).toBe(true);
		expect(refAllowed("c", "a/b,c")).toBe(true);
		expect(refAllowed("a", "a/b")).toBe(false);
		expect(refAllowed("a/b", "")).toBe(false);
	});
});

const dispatchDirs: string[] = [];
afterEach(() => {
	for (const dir of dispatchDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// PATH stand-ins are POSIX executables; the dispatch/parser code is shared with Windows.
describe.skipIf(process.platform === "win32")("ci-run dispatch receipt consumer", () => {
	const execute = promisify(execFile);
	function fixture() {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-dispatch-receipt-"));
		dispatchDirs.push(dir);
		fs.writeFileSync(
			path.join(dir, "gh"),
			`#!/bin/sh
printf '%s\\n' "$*" >> "$DISPATCH_TRACE"
for arg do
  case "$arg" in
    */dispatches)
      case "$DISPATCH_BODY" in
        __receipt__) printf '{"workflow_run_id":%s,"html_url":"https://github.com/test/repo/actions/runs/%s"}\\n' "$OWN_RUN" "$OWN_RUN" ;;
        __network__) echo 'connection reset after request was sent' >&2; exit 1 ;;
        *) printf '%s' "$DISPATCH_BODY" ;;
      esac
      exit 0 ;;
  esac
done
if [ "$1 $2" = 'variable get' ]; then echo concurrent-dispatch; exit 0; fi
if [ "$1 $2" = 'run list' ]; then
  echo '[{"databaseId":999999,"createdAt":"2099-01-01T00:00:00Z","headSha":"other","url":"https://github.com/test/repo/actions/runs/999999"}]'
else
  echo '{}'
fi
`,
			{ mode: 0o755 },
		);
		return {
			dir,
			start: (
				id: number,
				body = "__receipt__",
				argv = ["formal", "--ref", "concurrent-dispatch", "-f", "only=unit"],
			) =>
				execute("bun", [path.resolve("scripts/ci-run.ts"), ...argv], {
					env: {
						...process.env,
						PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`,
						OWN_RUN: String(id),
						DISPATCH_TRACE: path.join(dir, `trace-${id}`),
						DISPATCH_BODY: body,
					},
				}),
		};
	}

	it("keeps two concurrent dispatches on the same ref attached to their own returned run IDs", async () => {
		const { start } = fixture();
		const [first, second] = await Promise.all([start(101), start(202)]);
		expect(first.stdout).toContain("watch it once: bun scripts/watch-run.ts 101");
		expect(second.stdout).toContain("watch it once: bun scripts/watch-run.ts 202");
		expect(first.stdout + second.stdout).not.toContain("watch it once: bun scripts/watch-run.ts 999999");
	});

	it("returns the receipt for a macOS dispatch without waiting for a run listing", async () => {
		const { start, dir } = fixture();
		const result = await start(505, undefined, ["shell-batch-checks", "--ref", "concurrent-dispatch"]);
		expect(result.stdout).toContain("watch it once: bun scripts/watch-run.ts 505");
		const trace = fs.readFileSync(path.join(dir, "trace-505"), "utf8");
		expect(trace).not.toContain("shell-batch-checks.yml/runs?");
	});

	it.each([
		["missing ID", "{}"],
		["empty response", ""],
		["malformed response", "{broken"],
		["zero ID", '{"workflow_run_id":0}'],
		["fractional ID", '{"workflow_run_id":3.5}'],
		["unsafe integer ID", '{"workflow_run_id":9007199254740992}'],
		["string ID", '{"workflow_run_id":"303"}'],
		["lost response after sending", "__network__"],
	])("retains %s without attributing a candidate or dispatching again", async (_reason, body) => {
		const { start, dir } = fixture();
		await expect(start(303, body)).rejects.toMatchObject({
			code: 1,
			stdout: expect.not.stringContaining("watch it once:"),
			stderr: expect.stringContaining("unconfirmed"),
		});
		const trace = fs.readFileSync(path.join(dir, "trace-303"), "utf8").trim().split("\n");
		expect(trace.filter(line => line.includes("/dispatches"))).toHaveLength(1);
	});
});
