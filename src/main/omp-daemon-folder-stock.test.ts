import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, describe, expect, it } from "vitest";
import { initRepo, pathExists, stockShapedWorktree } from "./local/git/test-repos";
import { removeWorktree } from "./local/git/worktree";
import type { BridgeClient } from "./local/types";
import {
	configDirName,
	OMP_COMMAND,
	INSTALLED_OMP as omp,
	stopOmpDaemon,
	withoutAwsCredentials,
} from "./test-bridge-probe";
import { RM_TEMP } from "./test-fake-omp";

/**
 * A worktree a session ran in can be removed once that session's omp is gone, while other sessions' omps still run.
 * omp 19 starts one daemon per config folder from whichever omp first needs it; the daemon takes that omp's working
 * folder and outlives it while any omp stays connected, and Windows refuses to remove a folder a running process has
 * as its working folder. Installed omp, scripted loopback provider (one `bash` call per prompt), no spend.
 */

type Frame = { type: string; [key: string]: unknown };

const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
	for (const cleanup of cleanups.reverse()) await cleanup();
});

function sse(delta: unknown, finish: string): string {
	const frame = (value: unknown, reason: string | null = null) =>
		`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m1", choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`;
	return `${frame({ role: "assistant", content: "" })}${frame(delta)}${frame({}, finish)}data: [DONE]\n\n`;
}

/** The main agent runs one `bash` call, then answers; side requests (titles and the like) get a plain answer. */
async function startProvider(): Promise<string> {
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", chunk => {
			body += chunk;
		});
		req.on("end", () => {
			const parsed: { tools?: Array<{ function?: { name?: string } }>; messages?: Array<{ role?: string }> } =
				JSON.parse(body || "{}");
			res.writeHead(200, { "content-type": "text/event-stream" });
			const main = (parsed.tools ?? []).some(tool => tool.function?.name === "bash");
			if (!main || parsed.messages?.at(-1)?.role === "tool") {
				res.end(sse({ content: "done" }, "stop"));
				return;
			}
			const call = {
				index: 0,
				id: `call_${Math.random().toString(36).slice(2, 8)}`,
				type: "function",
				function: { name: "bash", arguments: JSON.stringify({ command: "echo here" }) },
			};
			res.end(sse({ tool_calls: [call] }, "tool_calls"));
		});
	});
	await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
	cleanups.push(() => {
		server.closeAllConnections();
		return new Promise<void>(done => server.close(() => done()));
	});
	return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
}

interface Omp {
	frames: Frame[];
	send(command: Record<string, unknown>): Promise<Frame>;
	stop(): Promise<void>;
}

/** An rpc omp in `cwd` on the shared private config `isolated`. */
async function startOmp(isolated: string, cwd: string): Promise<Omp> {
	const env: Record<string, string | undefined> = {
		...process.env,
		PI_CODING_AGENT_DIR: join(isolated, "agent"),
		PI_CONFIG_DIR: configDirName(isolated),
		OMP_PROFILE: "",
		PI_PROFILE: "",
	};
	for (const key of ["ELECTRON_RUN_AS_NODE", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_OAUTH_TOKEN"])
		Reflect.deleteProperty(env, key);
	withoutAwsCredentials(env, isolated);
	const child: ChildProcessWithoutNullStreams = spawn(
		OMP_COMMAND.file,
		[...OMP_COMMAND.args, "--mode", "rpc", "--no-extensions", "--no-skills", "--no-rules", "--model", "fake/m1"],
		{ cwd, env: env as NodeJS.ProcessEnv },
	);
	let stderr = "";
	child.stderr.on("data", chunk => {
		stderr += chunk;
	});
	const exited = new Promise<void>(done => child.once("exit", () => done()));
	const stop = async () => {
		child.stdin.end();
		const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
		await exited;
		clearTimeout(timer);
	};
	cleanups.push(stop);
	const frames: Frame[] = [];
	const responses = new Map<string, (frame: Frame) => void>();
	createInterface({ input: child.stdout }).on("line", line => {
		try {
			const frame = JSON.parse(line) as Frame & { id?: string };
			if (frame.type === "response" && frame.id && responses.has(frame.id)) responses.get(frame.id)?.(frame);
			else frames.push(frame);
		} catch {
			// not a frame
		}
	});
	await expect
		.poll(() => frames.some(frame => frame.type === "ready"), { timeout: 60_000, message: stderr })
		.toBe(true);
	let counter = 0;
	return {
		frames,
		stop,
		send: command =>
			new Promise<Frame>(done => {
				const id = `c${++counter}`;
				responses.set(id, done);
				child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
			}),
	};
}

/** One prompt to its end: the scripted `bash` call ran. */
async function runBash(o: Omp): Promise<void> {
	const before = o.frames.length;
	await o.send({ type: "prompt", message: "run it" });
	await expect
		.poll(() => o.frames.slice(before).some(frame => frame.type === "agent_end"), { timeout: 60_000 })
		.toBe(true);
}

/** The daemon `omp ps --json` names for this config, if any (omp 19's report; older omps have none). */
function daemonPid(isolated: string): number | undefined {
	const ps = spawnSync(OMP_COMMAND.file, [...OMP_COMMAND.args, "ps", "--json"], {
		env: { ...process.env, PI_CONFIG_DIR: configDirName(isolated) },
		encoding: "utf8",
		timeout: 30_000,
	});
	let report: unknown;
	try {
		report = JSON.parse(ps.stdout);
	} catch {
		return undefined;
	}
	const daemon = report && typeof report === "object" && "daemon" in report ? report.daemon : undefined;
	const pid = daemon && typeof daemon === "object" && "pid" in daemon ? daemon.pid : undefined;
	return typeof pid === "number" ? pid : undefined;
}

/** A Windows process's command line and working folder (read from its PEB), for the failure message. */
function describeProcess(pid: number): string {
	const script = `
$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"
"pid=$($p.ProcessId) parent=$($p.ParentProcessId) cmd=$($p.CommandLine)"
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class Cwd {
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int c, byte[] info, int len, out int ret);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr a, byte[] buf, int size, out IntPtr read);
  static IntPtr Ptr(IntPtr h, long at) { var b = new byte[8]; IntPtr r; ReadProcessMemory(h, new IntPtr(at), b, 8, out r); return new IntPtr(BitConverter.ToInt64(b, 0)); }
  public static string Of(int pid) {
    IntPtr h = OpenProcess(0x0410, false, pid); var info = new byte[48]; int ret;
    NtQueryInformationProcess(h, 0, info, 48, out ret);
    long peb = BitConverter.ToInt64(info, 8);
    long parameters = Ptr(h, peb + 0x20).ToInt64();
    var us = new byte[16]; IntPtr r; ReadProcessMemory(h, new IntPtr(parameters + 0x38), us, 16, out r);
    int length = BitConverter.ToUInt16(us, 0); long buffer = BitConverter.ToInt64(us, 8);
    var text = new byte[length]; ReadProcessMemory(h, new IntPtr(buffer), text, length, out r);
    return System.Text.Encoding.Unicode.GetString(text);
  }
}
"@
"cwd=$([Cwd]::Of(${pid}))"
Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { "child pid=$($_.ProcessId) cwd=$([Cwd]::Of($_.ProcessId)) cmd=$($_.CommandLine)" }
`;
	const out = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
		encoding: "utf8",
		timeout: 60_000,
	});
	return `${out.stdout}${out.stderr}`.trim();
}

describe.skipIf(process.platform !== "win32" || !existsSync(omp))("a worktree a session's omp ran in", () => {
	it("is removed once that omp ended, while another session's omp keeps running", async () => {
		const url = await startProvider();
		const isolated = realpathSync(mkdtempSync(join(tmpdir(), "ompdesk-daemon-folder-")));
		const repo = join(isolated, "repo");
		const root = join(isolated, "wt");
		const elsewhere = join(isolated, "elsewhere");
		mkdirSync(join(isolated, "agent"), { recursive: true });
		mkdirSync(elsewhere);
		cleanups.push(() => {
			stopOmpDaemon(isolated);
			rmSync(isolated, RM_TEMP);
		});
		writeFileSync(
			join(isolated, "agent", "models.yml"),
			`providers:\n  fake:\n    baseUrl: ${url}\n    apiKey: x\n    api: openai-completions\n    models:\n      - id: m1\n        name: m1\n        reasoning: false\n        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }\n`,
		);
		await initRepo(repo);
		const worktree = await stockShapedWorktree(repo, root, "session");

		const first = await startOmp(isolated, worktree.path);
		await runBash(first);
		const firstDaemon = daemonPid(isolated);
		const second = await startOmp(isolated, elsewhere);
		await runBash(second);
		await first.stop();
		const daemon = daemonPid(isolated);
		const held = daemon === undefined ? "no daemon" : describeProcess(daemon);

		const bridge: Pick<BridgeClient, "request"> = {
			async request<T>() {
				return { root, hash: "abc1234" } as T;
			},
		};
		try {
			await removeWorktree({ path: worktree.path }, bridge, repo);
		} catch (error) {
			// What removes it: ending the daemon (with its units) while the second omp still runs.
			if (daemon !== undefined) stopOmpDaemon(isolated);
			const after = await removeWorktree({ path: worktree.path }, bridge, repo).then(
				() => "removed after the daemon ended",
				(again: unknown) => `still refused after the daemon ended: ${String(again)}`,
			);
			throw new Error(
				[
					`removal refused: ${String(error)}`,
					`daemon after the first omp's prompt: ${firstDaemon ?? "none"}; after it ended: ${daemon ?? "none"}`,
					held,
					after,
				].join("\n"),
				{ cause: error },
			);
		}
		expect(await pathExists(worktree.path)).toBe(false);
		await second.stop();
	}, 300_000);
});
