/** Real schedule service + journals. Only stock, executable resolution and the actual session/omp launch are fixtures. */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, vi } from "vitest";
import type { Schedule, ScheduleDraft, ScheduleEvent } from "../../shared/schedules";
import { type CoreRunner, resolveBin } from "../local/git/exec";
import type { ScheduleServiceOptions } from "../schedules";
import type { TabActivity } from "../sidecar-pool";
import { RM_TEMP } from "../test-fake-omp";
import { type RoutineHost, type RoutineTabFact, routinePorts } from "./ports";
import { ObservedSchedules } from "./test-state";

export const until = (check: () => void) => vi.waitFor(check, { timeout: 10_000, interval: 10 });
export const idle = (tabId: string, stopReason = "stop", errorMessage?: string): TabActivity => ({
	type: "idle",
	tabId,
	outcome: { stopReason, ...(errorMessage === undefined ? {} : { errorMessage }) },
});
export type TestTab = RoutineTabFact & { title: string };

export function draft(cwd: string, event: ScheduleEvent, extra?: Partial<ScheduleDraft>): ScheduleDraft {
	return {
		name: "Routine",
		prompt: "Do the thing",
		cwd,
		model: null,
		autoApprove: false,
		enabled: true,
		frequency: { kind: "event", event },
		...extra,
	};
}

function runner(bin: string, home: string, args: string[] = []): CoreRunner {
	return {
		bin,
		args,
		timeoutMs: 30_000,
		maxBytes: 8 * 1024 * 1024,
		env: {
			PATH: process.env.PATH ?? "",
			...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
			HOME: home,
			USERPROFILE: home,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: join(home, "no-gitconfig"),
			GIT_TERMINAL_PROMPT: "0",
			GIT_OPTIONAL_LOCKS: "0",
			LC_ALL: "C",
		},
	};
}

export async function testGit(home: string): Promise<CoreRunner> {
	const bin = await resolveBin("git");
	if (!bin) throw new Error("git is needed for the repository fixture");
	return runner(bin, home, ["-c", "core.quotepath=false", "-c", "color.ui=false"]);
}

/** The real poll stops at its machine-tool lookup until the fixture permits that read. */
export function gate<T>() {
	const pending: Array<(value: T) => void> = [];
	const waiting = () => until(() => expect(pending.length).toBeGreaterThan(0));
	return {
		ask: () => {
			const { promise, resolve } = Promise.withResolvers<T>();
			pending.push(resolve);
			return promise;
		},
		waiting,
		allow: async (value: T) => {
			await waiting();
			pending.shift()!(value);
		},
	};
}

interface Options {
	ports?: Partial<Pick<RoutineHost, "git" | "github" | "email">>;
	timing?: RoutineHost["timing"];
	ready?: Promise<void>;
	hold?: boolean;
	now?: () => number;
	reserve?: ScheduleServiceOptions["reserve"];
}

const fixtures: { close(): Promise<void>; dir: string }[] = [];
afterEach(async () => {
	for (const f of fixtures.splice(0)) {
		await f.close();
		await rm(f.dir, RM_TEMP);
	}
});

export async function fixture(options: Options = {}) {
	const dir = mkdtempSync(join(tmpdir(), "schedule-routines-"));
	const work = join(dir, "project");
	mkdirSync(work);
	const file = join(dir, "routine-marks.json");
	const tabs: TestTab[] = [];
	const observers = new Set<(activity: TabActivity) => void>();
	const log: string[] = [];
	const fired: string[] = [];
	const launched: { schedule: Schedule; prompt: string; wake: boolean; finish(code?: number): void }[] = [];
	const launch = (schedule: Schedule, prompt: string, wake: boolean) => {
		const { promise, resolve } = Promise.withResolvers<{ code: number }>();
		const finish = (code = 0) => resolve({ code });
		launched.push({ schedule, prompt, wake, finish });
		const detail = prompt.split("\nWhat fired this run:\n")[1]?.trimEnd();
		if (detail && detail !== "A test run: no event fired") fired.push(...detail.split("\n"));
		if (!options.hold) finish();
		return { done: promise, stop: () => finish(130) };
	};
	const ports = routinePorts(
		{
			observeTabs: fn => {
				observers.add(fn);
				return () => {
					observers.delete(fn);
				};
			},
			resumeFacts: () => tabs,
			tabFacts: id => tabs.find(tab => tab.tabId === id),
		},
		{ pollAccount: () => null },
	);
	let service: ObservedSchedules;
	async function open(ready?: Promise<void>) {
		service = new ObservedSchedules({
			file: join(dir, "schedules.json"),
			logDir: join(dir, "runs"),
			tickMs: 3_600_000,
			launch: async (schedule, files) => launch(schedule, readFileSync(files.prompt, "utf8"), false),
			wake: async schedule => launch(schedule, schedule.prompt, true),
			onState: () => {},
			...(options.now ? { now: options.now } : {}),
			...(options.reserve ? { reserve: options.reserve } : {}),
		});
		await service.start({
			...ports,
			git: () => testGit(dir),
			github: async () => ({ home: dir, runner: null }),
			...options.ports,
			file,
			log: line => log.push(line),
			...(ready ? { ready } : {}),
			timing: {
				gitPollMs: 20,
				githubPollMs: 15,
				emailPollMs: 15,
				fileDebounceMs: 75,
				fileMaxWaitMs: 350,
				fileRetryMs: 50,
				quietMs: 0,
				...options.timing,
			},
		});
	}
	const close = () => service.dispose();
	const f = {
		dir,
		work,
		file,
		tabs,
		observers,
		fired,
		log,
		launched,
		close,
		get service() {
			return service;
		},
		reopen: async (ready?: Promise<void>) => {
			await close();
			await open(ready);
		},
		add: async (event: ScheduleEvent, extra?: Partial<ScheduleDraft>, origin?: string) =>
			(await service.create(draft(work, event, extra), origin)).id,
		marks: (): Record<string, { key: string; mark: unknown }> =>
			existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).marks : {},
		seed(id: string, mark: unknown) {
			const schedule = service.latest.schedules.find(schedule => schedule.id === id)!;
			if (schedule.frequency.kind !== "event") throw new Error("not an event fixture");
			writeFileSync(
				file,
				JSON.stringify({
					version: 1,
					marks: { [id]: { key: JSON.stringify([schedule.frequency.event, schedule.wakeSession ?? null]), mark } },
				}),
			);
		},
		async emit(activity: TabActivity) {
			for (const fn of observers) fn(activity);
			// A request on the same service lane fences every activity enqueued by this notification.
			await service.command({ action: "get" });
			if (!options.hold)
				await until(() => expect(service.latest.runs.some(run => run.status === "running")).toBe(false));
		},
	};
	fixtures.push(f);
	await open(options.ready);
	return f;
}

/**
 * The stand-in gh: `gh api <endpoint>` answers from the answers file and logs each endpoint it was asked. The core's
 * gate reads `rate_limit` before a background read (`gh/gate.rs`): that read is the gate's, not the trigger's, so it
 * is answered with plenty of quota and not logged.
 */
const FAKE_GH = `
const fs = require("node:fs");
const [answersFile, callsFile, , endpoint] = process.argv.slice(2);
if (endpoint === "rate_limit") {
	process.stdout.write(JSON.stringify({ resources: { core: { remaining: 5000, reset: 0 }, graphql: { remaining: 5000, reset: 0 } } }));
	process.exit(0);
}
fs.appendFileSync(callsFile, JSON.stringify(endpoint) + "\\n");
const answers = JSON.parse(fs.readFileSync(answersFile, "utf8"));
const key = Object.keys(answers).find(prefix => endpoint.startsWith(prefix));
if (key === undefined) {
	process.stderr.write("gh: HTTP 404: Not Found (" + endpoint + ")");
	process.exit(1);
}
const answer = answers[key];
if (answer && typeof answer === "object" && "__error" in answer) {
	process.stderr.write(answer.__error);
	process.exit(1);
}
process.stdout.write(JSON.stringify(answer));
`;

/** With no credentials or network, run a real child for each requested `gh api` endpoint. */
export function fakeGh(home: string, initial: Record<string, unknown>) {
	const dir = mkdtempSync(join(home, "gh-"));
	const answersFile = join(dir, "answers.json");
	const callsFile = join(dir, "calls.log");
	const script = join(dir, "gh.cjs");
	writeFileSync(script, FAKE_GH);
	const table: Record<string, unknown> = { ...initial };
	const save = () =>
		writeFileSync(
			answersFile,
			JSON.stringify(table, (_key, value) => (value instanceof Error ? { __error: value.message } : value)),
		);
	save();
	appendFileSync(callsFile, "");
	const tool = { home, runner: runner(process.execPath, home, [script, answersFile, callsFile]) };
	const answers = new Proxy(table, {
		set(target, key, value) {
			target[key as string] = value;
			save();
			return true;
		},
	});
	return {
		tool,
		answers,
		get calls(): string[] {
			return readFileSync(callsFile, "utf8")
				.split("\n")
				.filter(Boolean)
				.map(line => JSON.parse(line) as string);
		},
	};
}
