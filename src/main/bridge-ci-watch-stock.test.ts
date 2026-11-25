import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, describe, expect, it } from "vitest";
import {
	CI_MESSAGE_TYPE,
	CI_WATCH_END_ENTRY,
	CI_WATCH_ENTRY,
} from "../../resources/gui-bridge/modes/ci-watch-contracts";
import { CI_FIRST_READ_MS } from "../../resources/gui-bridge/modes/ci-watch-core";
import { GuiBridgeClient, newBridgeAddress, removeBridgeAddress } from "./bridge-client";
import { OMP_COMMAND, INSTALLED_OMP as omp, stockFixtureEnv, stopOmpDaemon } from "./test-bridge-probe";
import { removeWhenFree } from "./test-folders";

/**
 * The bridge's CI watch (resources/gui-bridge/modes/ci-watch.ts; control-tools.md › CI results of a session's pushes)
 * on the installed omp: a scripted OpenAI-compatible provider on loopback (no model spend) and a fake `gh` first on
 * omp's PATH that answers the `gh api` reads stock's `tools/gh-run-watch` makes from files the test writes and logs
 * every argv. No real GitHub, no real git: the push is a shell function named `git` that prints what `git push` prints
 * (to stderr, as git does), so the bash call's command holds `git push` and its output is a real push's shape.
 *
 * The first read comes 30 s after the push (`CI_FIRST_READ_MS`) on omp's clock, in another process, so no fake timer
 * reaches it. Instead of waiting it out, the journaled watches are moved 30 s into the past while omp is closed: the
 * relaunch's `rearm()` then reads them at once, which is the same engine a live session reads with.
 */

// shortcut: the fake gh is a POSIX sh script, so Windows skips; a gh.cmd shim if Windows coverage of this path matters.
const supported = existsSync(omp) && process.platform !== "win32";

const REMOTE = "To github.com:o/r.git";
/** git's abbreviated sha for `main`, expanded through `repos/o/r/commits/<sha>`. */
const MAIN_SHORT = "5d3c9e1";
const MAIN_SHA = `${MAIN_SHORT}${"4".repeat(33)}`;
/** A new branch's push prints no sha: its head comes from `repos/o/r/branches/feature`. */
const FEATURE_SHA = `9b8a7c6${"2".repeat(33)}`;

/** A command `isPushCommand` takes for a push, whose output is git's for `main` updated and `feature` created. */
function pushCommand(lines: string[], refs: string, wait = ""): string {
	const printed = lines.map(line => `'${line}'`).join(" ");
	return `git() { ${wait}printf '%s\\n' ${printed} >&2; }; git push origin ${refs}`;
}
const PUSH = pushCommand(
	[REMOTE, `   1f0e2d3..${MAIN_SHORT}  main -> main`, " * [new branch]      feature -> feature"],
	"main feature",
);
/** A push sent to the background: it takes a moment, as a real one does, so its output exists only after the call ends. */
const BACKGROUND_PUSH = pushCommand(
	[REMOTE, " * [new branch]      background -> background"],
	"background",
	"sleep 2; ",
);
const FOREGROUND_PUSH = pushCommand([REMOTE, " * [new branch]      foreground -> foreground"], "foreground");

const PUSH_MARK = "PUSH-MARK push main and feature";
const ASYNC_MARK = "ASYNC-MARK push in the background, then in the foreground";

type Frame = { type: string; message?: { customType?: string } };

const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
	for (const cleanup of cleanups.reverse()) await cleanup();
}, 180_000);

function sse(delta: unknown, finish: string): string {
	const frame = (value: unknown, reason: string | null = null) =>
		`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m1", choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`;
	return `${frame({ role: "assistant", content: "" })}${frame(delta)}${frame({}, finish)}data: [DONE]\n\n`;
}

function toolCall(name: string, args: Record<string, unknown>): string {
	const id = `call_${Math.random().toString(36).slice(2, 8)}`;
	return sse(
		{ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
		"tool_calls",
	);
}

/** Main-agent requests (they offer the shell tool) in order; a side request gets a plain answer and is not kept. */
async function startProvider(): Promise<{ url: string; bodies: string[] }> {
	const bodies: string[] = [];
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", chunk => {
			body += chunk;
		});
		req.on("end", () => {
			const parsed = JSON.parse(body || "{}") as { tools?: Array<{ function?: { name?: string } }> };
			const toolNamed = (end: string) =>
				(parsed.tools ?? []).find(tool => tool.function?.name?.endsWith(end))?.function?.name;
			const shell = toolNamed("bash");
			res.writeHead(200, { "content-type": "text/event-stream" });
			if (!shell) {
				res.end(sse({ content: "side" }, "stop"));
				return;
			}
			bodies.push(body);
			const results = body.split('"role":"tool"').length - 1;
			if (body.includes(PUSH_MARK) && results === 0) res.end(toolCall(shell, { command: PUSH }));
			else if (body.includes(ASYNC_MARK) && results === 0)
				res.end(toolCall(shell, { command: BACKGROUND_PUSH, async: true }));
			else if (body.includes(ASYNC_MARK) && results === 1) res.end(toolCall(toolNamed("wait") ?? "wait", {}));
			else if (body.includes(ASYNC_MARK) && results === 2) res.end(toolCall(shell, { command: FOREGROUND_PUSH }));
			else res.end(sse({ content: "DONE" }, "stop"));
		});
	});
	await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
	cleanups.push(() => {
		server.closeAllConnections();
		return new Promise<void>(done => server.close(() => done()));
	});
	return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, bodies };
}

interface FakeGh {
	/** The folder put first on omp's PATH. */
	bin: string;
	answer(endpoint: string, body: unknown): void;
	/** Every argv gh was run with, space-joined, in order. */
	calls(): string[];
}

/** A fake `gh` that logs its argv and prints `<dir>/<endpoint>.json` (`head_sha` joined to the runs listing), else 404s. */
function fakeGh(dir: string): FakeGh {
	const bin = join(dir, "bin");
	mkdirSync(bin, { recursive: true });
	const key = (endpoint: string) => endpoint.replace(/[/?=]/g, "_");
	writeFileSync(
		join(bin, "gh"),
		[
			"#!/bin/sh",
			`dir='${dir}'`,
			`printf '%s\\n' "$*" >> "$dir/gh.log"`,
			"endpoint=",
			'for arg in "$@"; do',
			"  case $arg in",
			"    /repos/*) endpoint=$arg ;;",
			'    head_sha=*) endpoint="$endpoint?$arg" ;;',
			"  esac",
			"done",
			`file="$dir/$(printf '%s' "$endpoint" | tr '/?=' '___').json"`,
			'if [ -f "$file" ]; then cat "$file"; else echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi',
			"",
		].join("\n"),
	);
	chmodSync(join(bin, "gh"), 0o755);
	const log = join(dir, "gh.log");
	return {
		bin,
		answer: (endpoint, body) => writeFileSync(join(dir, `${key(endpoint)}.json`), JSON.stringify(body)),
		calls: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []),
	};
}

interface Folders {
	isolated: string;
	root: string;
	gh: FakeGh;
}

function newFolders(): Folders {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-ci-watch-"));
	chmodSync(isolated, 0o700);
	const root = realpathSync(mkdtempSync(join(tmpdir(), "ompdesk-ci-watch-repo-")));
	const env = stockFixtureEnv(isolated);
	cleanups.push(async () => {
		stopOmpDaemon(isolated, env);
		await removeWhenFree(isolated);
		await removeWhenFree(root);
	});
	return { isolated, root, gh: fakeGh(join(isolated, "gh")) };
}

interface Omp {
	frames: Frame[];
	send(command: Record<string, unknown>): Promise<Frame>;
	/** Sends `message` and resolves once the turn it starts has ended. */
	prompt(message: string): Promise<void>;
	/** Closes stdin the way a quit does (stock disposes its session) and resolves once the process is gone. */
	stop(): Promise<void>;
}

/** omp over `--mode rpc-ui` with the bridge and the fake `gh` first on PATH; `resume` opens that session file again. */
async function startOmp(url: string, folders: Folders, resume?: string): Promise<Omp> {
	const { isolated, root, gh } = folders;
	const env = stockFixtureEnv(isolated);
	env.PATH = `${gh.bin}${delimiter}${env.PATH ?? ""}`;
	const agentDir = join(isolated, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "models.yml"),
		`providers:\n  fake:\n    baseUrl: ${url}\n    apiKey: x\n    api: openai-completions\n    models:\n      - id: m1\n        name: m1\n        reasoning: false\n        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }\n`,
	);
	const address = newBridgeAddress();
	env.OMP_GUI_BRIDGE = address;
	const child: ChildProcessWithoutNullStreams = spawn(
		OMP_COMMAND.file,
		[
			...OMP_COMMAND.args,
			...["--mode", "rpc-ui", "--no-extensions", "--no-skills", "--no-rules"],
			...["--model", "fake/m1", "-e", resolve("resources/gui-bridge/index.ts")],
			...(resume ? ["--resume", resume] : []),
		],
		{ cwd: root, env },
	);
	let stderr = "";
	child.stderr.on("data", chunk => {
		stderr += chunk;
	});
	const exited = new Promise<void>(done => child.once("exit", () => done()));
	const bridge = new GuiBridgeClient(address);
	const stop = async () => {
		bridge.close();
		child.stdin.end();
		const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
		await exited;
		clearTimeout(timer);
		removeBridgeAddress(address);
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
	await expect
		.poll(
			() =>
				bridge.connect(1_000).then(
					() => true,
					() => false,
				),
			{ timeout: 60_000, message: `bridge never came up\n${stderr.slice(-2000)}` },
		)
		.toBe(true);
	let counter = 0;
	const send = (command: Record<string, unknown>) => {
		const id = `c${++counter}`;
		const { promise, resolve: done } = Promise.withResolvers<Frame>();
		responses.set(id, done);
		child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
		return promise;
	};
	return {
		frames,
		send,
		prompt: async message => {
			const from = frames.length;
			await send({ type: "prompt", message });
			await expect
				.poll(() => frames.slice(from).some(frame => frame.type === "agent_end"), {
					timeout: 60_000,
					message: `the turn never ended\n${stderr.slice(-2000)}`,
				})
				.toBe(true);
		},
		stop,
	};
}

type Entry = {
	type?: string;
	customType?: string;
	content?: unknown;
	data?: { id?: string; branch?: string; sha?: string; at?: number; reason?: string };
	details?: Record<string, unknown>;
};

/** The session files stock wrote. */
function sessionFiles(isolated: string): string[] {
	const sessions = join(isolated, "agent", "sessions");
	if (!existsSync(sessions)) return [];
	return readdirSync(sessions).flatMap(project =>
		readdirSync(join(sessions, project))
			.filter(name => name.endsWith(".jsonl"))
			.map(file => join(sessions, project, file)),
	);
}

function journal(isolated: string): Entry[] {
	return sessionFiles(isolated).flatMap(file =>
		readFileSync(file, "utf8")
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as Entry),
	);
}

const watches = (entries: Entry[]) =>
	entries.filter(entry => entry.type === "custom" && entry.customType === CI_WATCH_ENTRY);
const ciLines = (entries: Entry[]) =>
	entries.filter(entry => entry.type === "custom_message" && entry.customType === CI_MESSAGE_TYPE);
const shown = (frames: Frame[]) =>
	frames.filter(frame => frame.type === "message_end" && frame.message?.customType === CI_MESSAGE_TYPE).length;

/** Moves every journaled watch `CI_FIRST_READ_MS` into the past, as if omp had been closed for those 30 s. */
function ageWatches(file: string): void {
	const lines = readFileSync(file, "utf8").split("\n");
	const aged = lines.map(line => {
		if (!line.includes(CI_WATCH_ENTRY)) return line;
		const entry = JSON.parse(line) as Entry;
		if (entry.type !== "custom" || entry.customType !== CI_WATCH_ENTRY || typeof entry.data?.at !== "number")
			return line;
		return JSON.stringify({ ...entry, data: { ...entry.data, at: entry.data.at - CI_FIRST_READ_MS } });
	});
	writeFileSync(file, aged.join("\n"));
}

const run = (id: number, branch: string, sha: string, status: string, conclusion: string | null) => ({
	total_count: 1,
	workflow_runs: [
		{
			id,
			name: "CI",
			status,
			conclusion,
			head_branch: branch,
			head_sha: sha,
			html_url: `https://github.com/o/r/actions/runs/${id}`,
		},
	],
});
const jobs = (list: Array<[number, string, string, string | null]>) => ({
	total_count: list.length,
	jobs: list.map(([id, name, status, conclusion]) => ({ id, name, status, conclusion })),
});

describe.skipIf(!supported)("CI watch on stock omp", () => {
	it("tells a push's CI result once, between turns, and never again after a relaunch", async () => {
		const provider = await startProvider();
		const folders = newFolders();
		const { gh } = folders;
		gh.answer(`/repos/o/r/commits/${MAIN_SHORT}`, { sha: MAIN_SHA });
		gh.answer("/repos/o/r/branches/feature", { commit: { sha: FEATURE_SHA } });
		gh.answer(`/repos/o/r/actions/runs?head_sha=${MAIN_SHA}`, run(101, "main", MAIN_SHA, "completed", "success"));
		gh.answer("/repos/o/r/actions/runs/101/jobs", jobs([[1001, "test", "completed", "success"]]));
		// `feature` stays running through the first relaunch: it is the read the second relaunch waits on.
		gh.answer(
			`/repos/o/r/actions/runs?head_sha=${FEATURE_SHA}`,
			run(202, "feature", FEATURE_SHA, "in_progress", null),
		);
		gh.answer("/repos/o/r/actions/runs/202/jobs", jobs([[2001, "lint", "in_progress", null]]));

		// The push: one bash call, two branches, journaled at once; nothing is read before 30 s.
		const first = await startOmp(provider.url, folders);
		await first.prompt(PUSH_MARK);
		await expect.poll(() => watches(journal(folders.isolated)).length, { timeout: 30_000 }).toBe(2);
		expect(watches(journal(folders.isolated)).map(entry => [entry.data?.branch, entry.data?.sha])).toEqual([
			["main", MAIN_SHORT],
			["feature", undefined],
		]);
		await first.stop();
		expect(gh.calls()).toEqual([]);
		const [file, ...others] = sessionFiles(folders.isolated);
		expect(others).toEqual([]);
		ageWatches(file as string);

		// Relaunched past the first read: `main` passed and is told, `feature` is still running.
		const requests = provider.bodies.length;
		const second = await startOmp(provider.url, folders, file);
		await expect.poll(() => ciLines(journal(folders.isolated)).length, { timeout: 60_000 }).toBe(1);
		const [line] = ciLines(journal(folders.isolated));
		expect(line?.content).toBe(`CI passed for o/r@${MAIN_SHORT} (main).`);
		expect(line?.details).toMatchObject({
			host: "github.com",
			repo: "o/r",
			branch: "main",
			sha: MAIN_SHA,
			outcome: "success",
			failed: [],
			url: "https://github.com/o/r/actions/runs/101",
		});
		await expect.poll(() => shown(second.frames), { timeout: 10_000 }).toBe(1);
		await expect
			.poll(() => gh.calls().some(call => call.includes("/actions/runs/202/jobs")), { timeout: 30_000 })
			.toBe(true);
		const delivered = journal(folders.isolated).filter(
			entry => entry.type === "custom" && entry.customType === CI_WATCH_END_ENTRY,
		);
		expect(delivered.map(entry => entry.data)).toEqual([{ id: line?.details?.id, reason: "delivered" }]);
		// No turn started for it: no request, no `agent_start`, until the person's next prompt, which carries the line.
		expect(provider.bodies.length).toBe(requests);
		expect(second.frames.some(frame => frame.type === "agent_start")).toBe(false);
		await second.prompt("after the push");
		expect(provider.bodies.length).toBe(requests + 1);
		expect(provider.bodies.at(-1)).toContain(`CI passed for o/r@${MAIN_SHORT} (main).`);
		await second.stop();
		const readsBefore = gh.calls().length;

		// `feature` failed meanwhile. The next relaunch reads only it: `main`'s line is in the journal.
		gh.answer(
			`/repos/o/r/actions/runs?head_sha=${FEATURE_SHA}`,
			run(202, "feature", FEATURE_SHA, "completed", "failure"),
		);
		gh.answer(
			"/repos/o/r/actions/runs/202/jobs",
			jobs([
				[2001, "lint", "completed", "failure"],
				[2002, "test", "completed", "success"],
			]),
		);
		const third = await startOmp(provider.url, folders, file);
		await expect.poll(() => ciLines(journal(folders.isolated)).length, { timeout: 60_000 }).toBe(2);
		const lines = ciLines(journal(folders.isolated));
		expect(lines.map(entry => entry.details?.branch)).toEqual(["main", "feature"]);
		expect(lines[1]?.content).toBe(
			`CI failed for o/r@${FEATURE_SHA.slice(0, 7)} (feature): lint. https://github.com/o/r/actions/runs/202`,
		);
		expect(shown(third.frames)).toBe(1);
		// Armed again, `main` (the older watch) would start its first gh read with `feature`'s first, three reads before `feature`'s line.
		const reads = gh.calls().slice(readsBefore);
		expect(reads.length).toBeGreaterThan(0);
		expect(reads.filter(call => call.includes(MAIN_SHORT) || call.includes("runs/101"))).toEqual([]);
		expect(provider.bodies.length).toBe(requests + 1);
		await third.prompt("after the relaunch");
		expect(provider.bodies.length).toBe(requests + 2);
		console.info(`gh argv stock used:\n${gh.calls().join("\n")}`);
	}, 240_000);

	it("does not watch a push sent to the background (the shortcut in ci-watch.ts), only one that ran in the call", async () => {
		const provider = await startProvider();
		const folders = newFolders();
		const session = await startOmp(provider.url, folders);
		await session.prompt(ASYNC_MARK);
		await expect.poll(() => watches(journal(folders.isolated)).length, { timeout: 30_000 }).toBe(1);
		// The background push's output did reach the agent (through `wait`), and still made no watch.
		expect(provider.bodies.some(body => body.includes("background -> background"))).toBe(true);
		expect(watches(journal(folders.isolated)).map(entry => entry.data?.branch)).toEqual(["foreground"]);
		await session.stop();
	}, 120_000);
});
