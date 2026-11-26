/**
 * Settings › Schedules: the list main keeps (src/main/schedules.ts) with its
 * master switch, per-schedule switch, Run now / Stop, edit and delete, search and
 * folder groups, templates, the editor dialog (cron, webhook filters, thinking,
 * worktree), a webhook routine's panel and recent calls, recent runs with their
 * logs, and the All runs table.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Schedule, SchedulesRequest, SchedulesState } from "../../../shared/schedules";
import { I18nProvider } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { setFocusedSessionRuntime } from "../../stores/session-runtime-context";
import { useTabsStore } from "../../stores/tabs";
import { SchedulesSection } from "./SchedulesSection";

const openPeer = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../layout/work-board/open-peer", () => ({ openPeer }));

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const SCHEDULE: Schedule = {
	id: "s1",
	name: "Nightly tidy",
	prompt: "Tidy the README",
	cwd: "/work/app",
	frequency: { kind: "daily", time: "09:30", days: [] },
	model: null,
	autoApprove: false,
	enabled: true,
	createdAt: "2026-10-01T00:00:00.000Z",
};

function emptyState(): SchedulesState {
	return { paused: false, schedules: [], runs: [], nextRuns: {} };
}

let state: SchedulesState = emptyState();
let failGet = false;
const command = vi.fn(async (request: SchedulesRequest, _device?: string): Promise<SchedulesState> => {
	if (request.action === "get" && failGet) throw new Error("disk unreadable");
	if (request.action === "save") {
		const schedule: Schedule = { ...request.draft, id: request.id ?? "new", createdAt: SCHEDULE.createdAt };
		state = { ...state, schedules: [...state.schedules.filter(item => item.id !== schedule.id), schedule] };
	}
	if (request.action === "setPaused") state = { ...state, paused: request.paused };
	if (request.action === "delete")
		state = { ...state, schedules: state.schedules.filter(item => item.id !== request.id) };
	return state;
});
const readLog = vi.fn(async (_runId: string) => "$ omp -p\n\nAll tidy.");
const showOpenDialog = vi.fn(async () => ["/work/app"]);
let hostListener: ((device: string, next: SchedulesState) => void) | null = null;
const onHostState = vi.fn((callback: (device: string, next: SchedulesState) => void) => {
	hostListener = callback;
	return () => {
		hostListener = null;
	};
});
const mailCommand = vi.fn(async (_request: { action: string }) => ({
	accounts: [
		{
			id: "a1",
			label: "Work mail",
			host: "imap.example.com",
			port: 993,
			username: "owner@example.com",
			mailbox: "INBOX",
			address: "owner@example.com",
			hasPassword: true,
		},
	],
}));
Object.assign(window as unknown as Record<string, unknown>, {
	omp: {
		schedules: { command, readLog, onState: () => () => {}, onHostState },
		mailAccounts: { command: mailCommand, test: vi.fn() },
		system: { showOpenDialog },
	},
});

const roots: Root[] = [];
async function mount(): Promise<void> {
	const root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<SchedulesSection />
			</I18nProvider>,
		);
	});
	await act(async () => {
		await Promise.resolve();
	});
	roots.push(root);
}

afterEach(async () => {
	for (const root of roots.splice(0)) await act(async () => root.unmount());
	document.body.innerHTML = "";
	state = emptyState();
	failGet = false;
	command.mockClear();
	readLog.mockClear();
	useSessionStore.getState().reset();
	useTabsStore.getState().reset();
});

function reactProps(element: object): Record<string, (event: object) => void> {
	const record = element as Record<string, unknown>;
	const key = Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$"));
	if (!key) throw new Error("react props not found");
	return record[key] as Record<string, (event: object) => void>;
}

async function click(element: object | null): Promise<void> {
	if (!element) throw new Error("click: element missing");
	await act(async () => reactProps(element).onClick?.({ preventDefault() {}, stopPropagation() {} }));
	await act(async () => {
		await Promise.resolve();
	});
}

function button(label: string): object | null {
	return (
		[...document.body.querySelectorAll("button")].find(
			item => item.getAttribute("aria-label") === label || (item.textContent ?? "").trim() === label,
		) ?? null
	);
}

async function type(label: string, value: string): Promise<void> {
	const field = [...document.body.querySelectorAll("label")].find(item => (item.textContent ?? "").trim() === label);
	const id = field?.getAttribute("for");
	const control = id ? document.body.querySelector(`[id="${id}"]`) : null;
	if (!control) throw new Error(`field "${label}" missing`);
	await act(async () => reactProps(control).onChange({ target: { value }, currentTarget: { value } }));
}

describe("SchedulesSection", () => {
	it("says when schedules run and creates one from the empty state", async () => {
		useSessionStore.setState({ cwd: "/work/app" });
		await mount();
		// A local tab: this computer's own service (no device).
		expect(command).toHaveBeenCalledWith({ action: "get" }, undefined);
		expect(document.body.textContent).toContain("Schedules run only while OMPdesk is open");
		expect(document.body.textContent).toContain("No schedules yet");

		await click(document.body.querySelector("[data-schedule-new]"));
		expect(document.body.querySelector("[data-schedule-cwd]")?.textContent).toBe("/work/app");
		// Nothing typed yet: the form says what is missing instead of saving.
		await act(async () =>
			reactProps(document.body.querySelector("[data-schedule-form]") as object).onSubmit({ preventDefault() {} }),
		);
		expect(document.body.textContent).toContain("Give the schedule a name.");
		expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ action: "save" }), undefined);

		await type("Name", "Nightly tidy");
		await type("Prompt", "Tidy the README");
		await click(document.body.querySelector('[data-schedule-day="1"]'));
		await act(async () =>
			reactProps(document.body.querySelector("[data-schedule-form]") as object).onSubmit({ preventDefault() {} }),
		);
		expect(command).toHaveBeenCalledWith(
			{
				action: "save",
				draft: {
					name: "Nightly tidy",
					prompt: "Tidy the README",
					cwd: "/work/app",
					frequency: { kind: "daily", time: "09:00", days: [1] },
					model: null,
					autoApprove: false,
					enabled: true,
					thinking: null,
					worktree: false,
				},
			},
			undefined,
		);
		const row = document.body.querySelector('[data-schedule="new"]');
		expect(row?.textContent).toContain("Nightly tidy");
		expect(row?.textContent).toContain("at 09:00");
		expect(document.body.querySelector('[data-schedule-group="/work/app"] h3')?.textContent).toContain("app");
	});

	it("runs, stops, pauses, toggles and deletes from the list", async () => {
		state = {
			paused: false,
			schedules: [SCHEDULE],
			runs: [
				{
					id: "r1",
					scheduleId: "s1",
					trigger: "manual",
					startedAt: new Date().toISOString(),
					endedAt: null,
					status: "running",
					exitCode: null,
					error: null,
				},
			],
			nextRuns: { s1: new Date().toISOString() },
		};
		await mount();
		const row = document.body.querySelector('[data-schedule="s1"]');
		expect(row?.textContent).toContain("Every day at 09:30");
		expect(row?.textContent).toContain("Running");

		await click(row?.querySelector('[aria-label="Stop Nightly tidy"]') ?? null);
		expect(command).toHaveBeenCalledWith({ action: "stop", runId: "r1" }, undefined);

		// The running run stays in Recent runs (its log), with its one Stop on the schedule's row.
		const runningRow = document.body.querySelector('[data-schedule-run-row="r1"]');
		expect(runningRow?.querySelector("[aria-expanded]")).not.toBeNull();
		expect(runningRow?.querySelectorAll("button")).toHaveLength(1);
		state = { ...state, runs: [] };
		await act(async () =>
			reactProps(
				document.body.querySelector('[role="switch"][aria-label="Run Nightly tidy on schedule"]') as object,
			).onClick({}),
		);
		expect(command).toHaveBeenCalledWith({ action: "setEnabled", id: "s1", enabled: false }, undefined);

		const master = document.body.querySelector("[data-schedules-master]");
		await act(async () => reactProps(master as object).onClick({}));
		expect(command).toHaveBeenCalledWith({ action: "setPaused", paused: true }, undefined);
		expect(document.body.querySelector("[data-schedule-next]")?.textContent).toBe("Paused");

		await act(async () => (button("Actions for Nightly tidy") as HTMLButtonElement).click());
		const deleteItem = [...document.body.querySelectorAll('[role="menuitem"]')].find(item =>
			(item.textContent ?? "").includes("Delete"),
		) as HTMLElement | undefined;
		await act(async () => deleteItem?.click());
		expect(document.body.textContent).toContain("Delete this schedule?");
		const confirm = [...document.body.querySelectorAll('[role="dialog"] button')].find(
			item => (item.textContent ?? "").trim() === "Delete",
		);
		await click(confirm ?? null);
		expect(command).toHaveBeenCalledWith({ action: "delete", id: "s1" }, undefined);
		expect(document.body.textContent).toContain("No schedules yet");
	});

	it("lists recent runs with their outcome and opens a run's log", async () => {
		state = {
			paused: false,
			schedules: [SCHEDULE],
			runs: [
				{
					id: "r2",
					scheduleId: "s1",
					trigger: "schedule",
					startedAt: "2026-10-15T09:30:00.000Z",
					endedAt: "2026-10-15T09:31:05.000Z",
					status: "failed",
					exitCode: 2,
					error: null,
				},
				{
					id: "r1",
					scheduleId: "gone",
					trigger: "schedule",
					startedAt: "2026-10-14T09:30:00.000Z",
					endedAt: "2026-10-14T09:30:00.000Z",
					status: "skipped",
					exitCode: null,
					error: "The previous run was still going",
				},
			],
			nextRuns: { s1: null },
		};
		await mount();
		const failed = document.body.querySelector('[data-schedule-run-row="r2"]');
		expect(failed?.textContent).toContain("Failed");
		expect(failed?.textContent).toContain("omp exited with code 2");
		const skipped = document.body.querySelector('[data-schedule-run-row="r1"]');
		expect(skipped?.textContent).toContain("Skipped");
		expect(skipped?.textContent).toContain("Deleted schedule");
		expect(skipped?.querySelector("[aria-expanded]")).toBeNull();

		await click(failed?.querySelector("[aria-expanded]") ?? null);
		expect(readLog).toHaveBeenCalledWith("r2", undefined);
		expect(failed?.querySelector("[data-schedule-log]")?.textContent).toContain("All tidy.");
	});

	it("folds a repeated skip into one row, and sends a run that could not start again only until it was", async () => {
		const base = {
			scheduleId: "s1",
			trigger: "schedule" as const,
			startedAt: "2026-10-15T09:30:00.000Z",
			endedAt: "2026-10-15T09:30:00.000Z",
			exitCode: null,
		};
		state = {
			paused: false,
			schedules: [SCHEDULE],
			runs: [
				{ ...base, id: "r3", status: "skipped", error: "Its precheck said no: not ready", repeats: 4 },
				{ ...base, id: "r2", status: "failed", error: "Project folder not found: /work/app", notStarted: true },
				{
					...base,
					id: "r1",
					status: "failed",
					error: "Project folder not found",
					notStarted: true,
					resentAs: "r2",
				},
			],
			nextRuns: { s1: null },
		};
		await mount();
		const folded = document.body.querySelector('[data-schedule-run-row="r3"]');
		expect(folded?.querySelector("[data-schedule-run-repeats]")?.textContent).toBe("×4");
		const spent = document.body.querySelector('[data-schedule-run-row="r1"]');
		expect(spent?.textContent).not.toContain("Send again");
		const failed = document.body.querySelector('[data-schedule-run-row="r2"]');
		const sendAgain = [...(failed?.querySelectorAll("button") ?? [])].find(item => item.textContent === "Send again");
		await click(sendAgain ?? null);
		expect(command).toHaveBeenCalledWith({ action: "resend", runId: "r2" }, undefined);
	});

	it("shows what a run used", async () => {
		state = {
			paused: false,
			schedules: [SCHEDULE],
			runs: [
				{
					id: "r1",
					scheduleId: "s1",
					trigger: "schedule",
					startedAt: "2026-10-15T09:30:00.000Z",
					endedAt: "2026-10-15T09:31:00.000Z",
					status: "succeeded",
					exitCode: 0,
					error: null,
					usage: { input: 10_000, output: 2_000, cacheRead: 300, cacheWrite: 0, cost: 0.0123 },
				},
			],
			nextRuns: { s1: null },
		};
		await mount();
		expect(document.body.querySelector('[data-schedule-run-row="r1"]')?.textContent).toContain(
			"12.3k tokens · $0.01",
		);
	});

	it("offers a retry when the schedules cannot load", async () => {
		failGet = true;
		await mount();
		expect(document.body.textContent).toContain("Couldn't load schedules");
		expect(document.body.textContent).toContain("disk unreadable");
		failGet = false;
		await click(button("Retry"));
		expect(document.body.textContent).toContain("No schedules yet");
	});

	it("shows and changes a paired host's schedules while the focused tab runs there", async () => {
		useTabsStore.setState({
			tabs: [
				{ id: "t1", cwd: "C:\\work", status: "ready", kind: "agent", unreadDone: false, device: "host-studio" },
			],
			activeTabId: "t1",
		});
		setFocusedSessionRuntime("t1");
		state = { ...emptyState(), schedules: [{ ...SCHEDULE, cwd: "C:\\work" }] };
		await mount();
		expect(command).toHaveBeenCalledWith({ action: "get" }, "host-studio");
		expect(onHostState).toHaveBeenCalledTimes(1);
		expect(document.body.querySelector('[data-schedule="s1"]')?.textContent).toContain("Nightly tidy");

		await click(document.body.querySelector('[data-schedule="s1"] [data-schedule-run]'));
		expect(command).toHaveBeenLastCalledWith({ action: "runNow", id: "s1" }, "host-studio");

		// The host pushes its own change; it replaces what the section shows. Another host's push does not.
		await act(async () => hostListener?.("host-other", { ...state, schedules: [] }));
		expect(document.body.querySelector('[data-schedule="s1"]')).not.toBeNull();
		await act(async () => hostListener?.("host-studio", { ...state, paused: true }));
		expect(document.body.querySelector("[data-schedule-next]")?.textContent).toBe("Paused");
		expect(command.mock.calls.every(([, device]) => device === "host-studio")).toBe(true);
	});

	it("a command's late reply never overwrites a push that came while it was in flight", async () => {
		useTabsStore.setState({
			tabs: [
				{ id: "t1", cwd: "C:\\work", status: "ready", kind: "agent", unreadDone: false, device: "host-studio" },
			],
			activeTabId: "t1",
		});
		setFocusedSessionRuntime("t1");
		state = { ...emptyState(), schedules: [{ ...SCHEDULE, cwd: "C:\\work" }] };
		await mount();
		// Stop's reply carries the state at the moment it was asked (running); the run ended at once and main pushed
		// that (stopped) first. The slow reply must not put the row back on "running".
		const reply = Promise.withResolvers<SchedulesState>();
		command.mockImplementationOnce(async () => reply.promise);
		const before = state;
		await click(document.body.querySelector('[data-schedule="s1"] [data-schedule-run]'));
		await act(async () => hostListener?.("host-studio", { ...before, paused: true }));
		expect(document.body.querySelector("[data-schedule-next]")?.textContent).toBe("Paused");
		await act(async () => reply.resolve(before));
		expect(document.body.querySelector("[data-schedule-next]")?.textContent).toBe("Paused");
	});

	it("says what starts a one-time or event schedule and what fired its runs", async () => {
		const github: Schedule = {
			...SCHEDULE,
			id: "g1",
			name: "Review PRs",
			frequency: { kind: "event", event: { source: "github", repo: "octo/app", events: ["pull_request", "issue"] } },
		};
		const files: Schedule = {
			...SCHEDULE,
			id: "f1",
			name: "Watch src",
			frequency: { kind: "event", event: { source: "files", path: "/work/app/src" } },
		};
		const once: Schedule = {
			...SCHEDULE,
			id: "o1",
			name: "Follow up",
			frequency: { kind: "once", at: "2026-12-24T09:30:00.000Z" },
		};
		state = {
			paused: false,
			schedules: [github, files, once],
			runs: [
				{
					id: "r1",
					scheduleId: "g1",
					trigger: "event",
					startedAt: "2026-10-15T09:30:00.000Z",
					endedAt: "2026-10-15T09:31:00.000Z",
					status: "succeeded",
					exitCode: 0,
					error: null,
					detail: "PR #12 opened\nPR #13 opened",
				},
			],
			nextRuns: { g1: null, f1: null, o1: null },
		};
		await mount();

		expect(document.body.querySelector('[data-schedule="g1"]')?.textContent).toContain(
			"GitHub pull requests and issues in octo/app",
		);
		expect(document.body.querySelector('[data-schedule="f1"]')?.textContent).toContain("When files change under src");
		expect(document.body.querySelector('[data-schedule="o1"]')?.textContent).toContain("Once at");
		const fired = document.body.querySelector('[data-schedule-run-row="r1"]');
		expect(fired?.textContent).toContain("event");
		expect(fired?.querySelector("[data-schedule-run-detail]")?.textContent).toBe("PR #12 opened\nPR #13 opened");
	});

	it("keeps a one-time or event schedule's trigger when it is edited and saved", async () => {
		const watch: Schedule = {
			...SCHEDULE,
			id: "g1",
			name: "Review PRs",
			frequency: { kind: "event", event: { source: "github", repo: "octo/app", events: ["pull_request"] } },
		};
		const once: Schedule = {
			...SCHEDULE,
			id: "o1",
			name: "Follow up",
			frequency: { kind: "once", at: "2026-12-24T09:30:00.000Z" },
		};
		state = { ...emptyState(), schedules: [watch, once] };
		await mount();

		for (const schedule of [watch, once]) {
			await act(async () => (button(`Actions for ${schedule.name}`) as HTMLButtonElement).click());
			const edit = [...document.body.querySelectorAll('[role="menuitem"]')].find(item =>
				(item.textContent ?? "").includes("Edit"),
			) as HTMLElement | undefined;
			await act(async () => edit?.click());
			// The trigger is shown in words, with no repeat controls to turn it into a daily one.
			expect(document.body.querySelector("[data-schedule-fixed-trigger]")).not.toBeNull();
			expect(document.body.querySelector("[data-schedule-day]")).toBeNull();
			await type("Name", `${schedule.name} v2`);
			await act(async () =>
				reactProps(document.body.querySelector("[data-schedule-form]") as object).onSubmit({ preventDefault() {} }),
			);
			await act(async () => {
				await Promise.resolve();
			});
			expect(command).toHaveBeenCalledWith(
				{
					action: "save",
					id: schedule.id,
					draft: expect.objectContaining({ name: `${schedule.name} v2`, frequency: schedule.frequency }),
				},
				undefined,
			);
		}
	});

	it("lists this computer's email accounts, and on a paired host only says where they are set", async () => {
		const email: Schedule = {
			...SCHEDULE,
			id: "m1",
			name: "Triage",
			frequency: { kind: "event", event: { source: "email", account: "Work mail", from: "boss@example.com" } },
		};
		state = { ...emptyState(), schedules: [email] };
		await mount();
		expect(document.body.querySelector('[data-schedule="m1"]')?.textContent).toContain(
			"New mail in Work mail from boss@example.com",
		);
		expect(mailCommand).toHaveBeenCalledWith({ action: "list" });
		expect(document.body.querySelector('[data-mail-account="a1"]')?.textContent).toContain("Work mail");
		expect(document.body.querySelector("[data-mail-elsewhere]")).toBeNull();

		for (const root of roots.splice(0)) await act(async () => root.unmount());
		document.body.innerHTML = "";
		mailCommand.mockClear();
		useTabsStore.setState({
			tabs: [
				{ id: "t1", cwd: "C:\\work", status: "ready", kind: "agent", unreadDone: false, device: "host-studio" },
			],
			activeTabId: "t1",
		});
		setFocusedSessionRuntime("t1");
		await mount();
		expect(document.body.querySelector("[data-mail-elsewhere]")?.textContent).toContain(
			"set on that computer itself",
		);
		expect(document.body.querySelector("[data-mail-account]")).toBeNull();
		expect(mailCommand).not.toHaveBeenCalled();
	});

	it("finds schedules by name, prompt or folder and groups them by folder", async () => {
		state = {
			...emptyState(),
			schedules: [
				SCHEDULE,
				{ ...SCHEDULE, id: "s2", name: "Site check", prompt: "Look at the landing page", cwd: "/work/site" },
				{ ...SCHEDULE, id: "s3", name: "Bump deps", prompt: "Update dependencies", cwd: "/work/app" },
			],
		};
		await mount();
		const groups = [...document.body.querySelectorAll("[data-schedule-group]")];
		expect(groups.map(group => group.getAttribute("data-schedule-group"))).toEqual(["/work/app", "/work/site"]);
		expect(groups[0]?.querySelectorAll("[data-schedule]")).toHaveLength(2);
		expect(groups[1]?.querySelector("h3 [title]")?.getAttribute("title")).toBe("/work/site");

		await search("landing");
		expect(
			[...document.body.querySelectorAll("[data-schedule]")].map(row => row.getAttribute("data-schedule")),
		).toEqual(["s2"]);
		await search("/work/app");
		expect(document.body.querySelectorAll("[data-schedule]")).toHaveLength(2);
		await search("nothing like it");
		expect(document.body.textContent).toContain("No schedules match.");
	});

	it("starts a new schedule from a template", async () => {
		useSessionStore.setState({ cwd: "/work/app" });
		await mount();
		await click(document.body.querySelector('[data-schedule-template="prs"]'));
		const name = [...document.body.querySelectorAll("input")].find(input => input.value === "PR watch");
		expect(name).toBeDefined();
		expect((document.body.querySelector("textarea") as HTMLTextAreaElement | null)?.value).toContain(
			"Check open pull requests",
		);
		await submitForm();
		expect(command).toHaveBeenCalledWith(
			{
				action: "save",
				draft: expect.objectContaining({ name: "PR watch", frequency: { kind: "interval", minutes: 30 } }),
			},
			undefined,
		);
	});

	it("saves a cron schedule, says when its line is malformed, and sets thinking and a worktree", async () => {
		useSessionStore.setState({ cwd: "/work/app" });
		await mount();
		await click(document.body.querySelector("[data-schedule-new]"));
		await type("Name", "Weekday tidy");
		await type("Prompt", "Tidy the README");
		await change(document.body.querySelector("[data-schedule-repeat]"), "cron");
		await type("Cron expression", "every morning");
		await submitForm();
		expect(document.body.textContent).toContain("Enter five fields, like 0 9 * * 1-5.");
		expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ action: "save" }), undefined);

		await type("Cron expression", "30 8 * * 1-5");
		await type("Thinking", "high");
		const worktree = document.body.querySelector("[data-schedule-worktree]");
		await act(async () => reactProps(worktree as object).onChange({ target: { checked: true } }));
		await submitForm();
		expect(command).toHaveBeenCalledWith(
			{
				action: "save",
				draft: expect.objectContaining({
					frequency: { kind: "cron", expr: "30 8 * * 1-5" },
					thinking: "high",
					worktree: true,
				}),
			},
			undefined,
		);
	});

	it("saves a new webhook routine with an empty key and its Only when filters", async () => {
		useSessionStore.setState({ cwd: "/work/app" });
		await mount();
		await click(document.body.querySelector("[data-schedule-new]"));
		await type("Name", "Deploy hook");
		await type("Prompt", "Deploy what the call names");
		await change(document.body.querySelector("[data-schedule-repeat]"), "webhook");
		await click(button("Add a condition"));
		const row = document.body.querySelector('[data-schedule-where="0"]');
		await change(row?.querySelector('[aria-label="Path"]') ?? null, "body.action");
		await change(row?.querySelector('[aria-label="Values"]') ?? null, "opened, reopened");
		await click(button("Add a condition"));
		const second = document.body.querySelector('[data-schedule-where="1"]');
		await change(second?.querySelector('[aria-label="Path"]') ?? null, "headers.x-github-event");
		await change(second?.querySelector('[aria-label="Test"]') ?? null, "exists");
		await type("Body contains", "main");
		await type("Quote these fields", "body.ref, body.sender.login");
		await submitForm();
		expect(command).toHaveBeenCalledWith(
			{
				action: "save",
				draft: expect.objectContaining({
					frequency: {
						kind: "event",
						event: {
							source: "webhook",
							key: "",
							where: [
								{ path: "body.action", op: "=", values: ["opened", "reopened"] },
								{ path: "headers.x-github-event", op: "exists" },
							],
							contains: "main",
							pick: ["body.ref", "body.sender.login"],
						},
					},
				}),
			},
			undefined,
		);
	});

	it("opens a webhook routine's URL, key, signature, actions and recent calls", async () => {
		const until = new Date(Date.now() + 3_600_000).toISOString();
		state = {
			...emptyState(),
			schedules: [
				{
					...HOOK,
					frequency: {
						kind: "event",
						event: { ...HOOK_EVENT, signedBy: "github", previousKey: { key: "old-key-0123456789", until } },
					},
				},
			],
			runs: [{ ...RUN, id: "r9", scheduleId: "w1", trigger: "event" }],
			calls: {
				w1: [
					{ id: "c3", at: new Date().toISOString(), verdict: "started", run: "r9", sample: true },
					{ id: "c2", at: new Date().toISOString(), verdict: "refused", reason: "bad signature", count: 3 },
					{ id: "c1", at: new Date().toISOString(), verdict: "ignored" },
				],
			},
		};
		await mount();
		expect(document.body.querySelector("[data-schedule-group]")?.textContent).toContain("signed by GitHub");
		await click(document.body.querySelector('[data-schedule="w1"] [data-schedule-webhook-toggle]'));
		const panel = document.body.querySelector('[data-webhook-panel="w1"]');
		expect(panel?.querySelector("[data-webhook-url]")?.textContent).toBe("http://127.0.0.1:47831/hooks/w1");
		expect(panel?.textContent).not.toContain(HOOK_EVENT.key);
		await click(button("Reveal key"));
		expect(panel?.querySelector("[data-webhook-key]")?.textContent).toBe(HOOK_EVENT.key);
		expect(panel?.querySelector("[data-webhook-old-key]")?.textContent).toContain("Old key works until");
		expect(panel?.querySelector("[data-webhook-signed]")?.textContent).toContain("Signed by GitHub");

		const calls = [...(panel?.querySelectorAll("[data-webhook-call]") ?? [])].map(row => row.textContent);
		expect(calls[0]).toContain("Started");
		expect(calls[0]).toContain("View run");
		expect(calls[0]).toContain("sample");
		expect(calls[1]).toContain("Refused ×3");
		expect(calls[1]).toContain("bad signature");
		expect(calls[2]).toContain("Ignored");
		expect(calls[2]).toContain("didn't match Only when");

		await click(button("Send test call"));
		expect(command).toHaveBeenCalledWith({ action: "sampleCall", id: "w1" }, undefined);

		await click(button("Rotate key…"));
		const drop = [...document.body.querySelectorAll('[role="dialog"] input[type="radio"]')].find(
			input => input.getAttribute("value") === "drop",
		);
		await act(async () => reactProps(drop as object).onChange({ target: { checked: true } }));
		await click(document.body.querySelector("[data-webhook-rotate-confirm]"));
		expect(command).toHaveBeenCalledWith({ action: "rotateKey", id: "w1", keepOld: false }, undefined);

		await click(button("Remove signature"));
		const confirm = [...document.body.querySelectorAll('[role="dialog"] button')].find(
			item => (item.textContent ?? "").trim() === "Remove signature",
		);
		await click(confirm ?? null);
		expect(command).toHaveBeenCalledWith({ action: "setSecret", id: "w1", sender: null }, undefined);

		// A started call's run opens in All runs with its log.
		await click(button("View run"));
		expect(document.body.querySelector('[data-schedule-table-run="r9"]')).not.toBeNull();
		expect(readLog).toHaveBeenCalledWith("r9", undefined);
	});

	it("makes a signing secret it shows only as a Copy button", async () => {
		state = { ...emptyState(), schedules: [HOOK] };
		await mount();
		await click(document.body.querySelector('[data-schedule="w1"] [data-schedule-webhook-toggle]'));
		await click(button("Signing secret…"));
		// GitHub takes a secret it is given: OMPdesk makes it.
		await change(document.body.querySelector('[role="dialog"] select'), "github");
		await act(async () =>
			reactProps(document.body.querySelector("[data-webhook-secret-form]") as object).onSubmit({
				preventDefault() {},
			}),
		);
		await act(async () => {
			await Promise.resolve();
		});
		const sent = command.mock.calls.find(([request]) => request.action === "setSecret")?.[0];
		expect(sent).toMatchObject({ action: "setSecret", id: "w1", sender: "github" });
		const secret = sent?.action === "setSecret" ? (sent.secret ?? "") : "";
		expect(secret).toMatch(/^[0-9a-f]{32}$/);
		expect(document.body.querySelector("[data-webhook-secret-copy]")).not.toBeNull();
		expect(document.body.textContent).toContain("From now on, calls must carry its signature.");
		expect(document.body.textContent).not.toContain(secret);
	});

	it("lists every run in All runs with its log, session and Run again", async () => {
		state = {
			...emptyState(),
			schedules: [SCHEDULE],
			runs: [
				{
					...RUN,
					session: "/sessions/run.jsonl",
					worktree: "/work/.wt/gui-tidy-1234567",
					usage: { input: 10_000, output: 2_000, cacheRead: 300, cacheWrite: 0, cost: 0.0123 },
				},
				{ ...RUN, id: "r2", scheduleId: "gone" },
			],
		};
		await mount();
		const tab = [...document.body.querySelectorAll('[role="tab"]')].find(item =>
			(item.textContent ?? "").includes("All runs"),
		);
		await click(tab ?? null);
		const row = document.body.querySelector('[data-schedule-table-run="r1"]');
		expect(row?.textContent).toContain("Nightly tidy");
		expect(row?.textContent).toContain("Succeeded");
		expect(row?.textContent).toContain("12.3k tokens · $0.01");
		expect(row?.querySelector("[data-schedule-run-worktree]")?.textContent).toContain("gui-tidy-1234567");
		expect(document.body.querySelector('[data-schedule-table-run="r2"]')?.textContent).toContain("Deleted schedule");
		expect(document.body.querySelector('[data-schedule-table-run="r2"] [data-schedule-open-session]')).toBeNull();

		await click(row?.querySelector("[data-schedule-open-session]") ?? null);
		expect(openPeer).toHaveBeenCalledWith({ kind: "path", sessionPath: "/sessions/run.jsonl" });
		await click(row?.querySelector('[aria-label="Run Nightly tidy again"]') ?? null);
		expect(command).toHaveBeenCalledWith({ action: "runNow", id: "s1" }, undefined);
		await click(row?.querySelector('[aria-label="View log"]') ?? null);
		expect(readLog).toHaveBeenCalledWith("r1", undefined);
		expect(document.body.querySelector("[data-schedule-log]")?.textContent).toContain("All tidy.");
	});
});

const HOOK_EVENT = { source: "webhook" as const, key: "hook-key-abcdefghijklmnop" };
const HOOK: Schedule = {
	...SCHEDULE,
	id: "w1",
	name: "Deploy hook",
	frequency: { kind: "event", event: HOOK_EVENT },
};
const RUN = {
	id: "r1",
	scheduleId: "s1",
	trigger: "schedule" as const,
	startedAt: "2026-10-15T09:30:00.000Z",
	endedAt: "2026-10-15T09:31:00.000Z",
	status: "succeeded" as const,
	exitCode: 0,
	error: null,
};

async function search(text: string): Promise<void> {
	const field = document.body.querySelector("[data-schedule-search]");
	await act(async () =>
		reactProps(field as object).onChange({ target: { value: text }, currentTarget: { value: text } }),
	);
}

async function change(control: object | null, value: string): Promise<void> {
	if (!control) throw new Error("change: control missing");
	await act(async () => reactProps(control).onChange({ target: { value }, currentTarget: { value } }));
}

async function submitForm(): Promise<void> {
	await act(async () =>
		reactProps(document.body.querySelector("[data-schedule-form]") as object).onSubmit({ preventDefault() {} }),
	);
	await act(async () => {
		await Promise.resolve();
	});
}
