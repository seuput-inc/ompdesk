/**
 * New tasks being made by the new task sheet (`dialogs/WorktreeDialog.tsx`), each one a fixed run of steps on the
 * computer it was asked of: fetch the remote default branch (a `default` base), name it from its first prompt (no name
 * typed), make the worktree, prepare it (`.worktreeinclude`, `.ompdesk/worktree-setup`), then open its session and send
 * the first prompt with its files. Its sidebar row (`layout/sidebar/NewTaskRows.tsx`) shows the steps and their times
 * while it runs; a failed one keeps its row with Retry, which runs again from the failed step (the create carries the
 * task's id as its request id, so a retry after a lost answer gets the same worktree), and Close. A task that opened
 * its session leaves the store: the session's own row takes over.
 *
 * Orca FB17 (MIT, re-implemented): `rows/PendingWorktreeRow.tsx:40-113`, `worktree-creation/worktree-setup-steps.ts:31-104`
 * (a step runs, is done with its time, or failed; steps not reached are pending) and `worktree-creation-clock.ts:4-24`.
 */
import { create } from "zustand";
import type {
	ImageContent,
	RpcResponse,
	RpcWorktreeCreateResult,
	RpcWorktreePrepared,
	WorktreeWait,
} from "../../shared/rpc-types";
import { GUI_WORKTREE_BRANCH_PREFIX } from "../../shared/worktree-branch";
import { fileTextAttachment, intakeComposerFiles } from "../components/layout/composer/composer-files";
import { fileToImage } from "../components/layout/composer/input-area-utils";
import { type InlineFailure, inlineFailure } from "../lib/error-detail";
import { translate } from "../lib/i18n";
import { createTabRpc, type TabRpc } from "../lib/tab-rpc";
import { webRuntime } from "../web/runtime";
import { ensureTabRuntime } from "./tab-runtime";
import { type SessionTab, useTabsStore } from "./tabs";
import { toast } from "./toast";

export type NewTaskStepId = "fetch" | "name" | "create" | "prepare" | "start";
export type NewTaskStepState = "pending" | "running" | "done" | "failed";

export interface NewTaskStep {
	id: NewTaskStepId;
	state: NewTaskStepState;
	startedAt?: number;
	endedAt?: number;
}

export interface NewTaskRequest {
	/** The project folder: the main checkout a worktree is cut from, or the folder the session opens in. */
	baseCwd: string;
	/** A paired host's id; absent on this computer. */
	device?: string;
	/** A worktree of its own; false opens the session in `baseCwd`. */
	worktree: boolean;
	/** The worktree's name as typed; empty: named from the prompt (`name` step). */
	name: string;
	baseRef: string;
	branchPrefix?: string;
	/** The exact branch, cut from `baseRef` instead of `<branchPrefix><name>` (a Linear issue's `branchName`). */
	branch?: string;
	sparse?: string;
	prompt: string;
	files: readonly File[];
}

export interface NewTask {
	id: string;
	request: NewTaskRequest;
	steps: NewTaskStep[];
	status: "running" | "failed";
	error?: InlineFailure;
	wait?: WorktreeWait;
	/** The worktree's name once known (typed, suggested, or the fallback). */
	name?: string;
	/** The name is only the fallback (`task-<id>`): the branch takes the session's first title (FS91). */
	placeholderName?: true;
	made?: RpcWorktreeCreateResult;
	tabId?: string;
	startedAt: number;
}

interface NewTasksStore {
	tasks: Record<string, NewTask>;
	reset: () => void;
}

export const useNewTasksStore = create<NewTasksStore>()(set => ({
	tasks: {},
	reset: () => set({ tasks: {} }),
}));

/** The steps a request runs, in order. */
export function stepsFor(request: NewTaskRequest): NewTaskStepId[] {
	if (!request.worktree) return ["start"];
	return [
		...(request.baseRef === "default" ? (["fetch"] as const) : []),
		...(request.name.trim() ? [] : (["name"] as const)),
		"create",
		"prepare",
		"start",
	];
}

/** The worktree name's slug, as main's `worktreeSlug` makes it (`local/git/parse.ts`). */
export function worktreeSlug(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(/[^a-z0-9-]/g, "")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 41)
		.replace(/-+$/, "");
}

const rpcs = new Map<string, TabRpc>();

function patch(id: string, change: (task: NewTask) => Partial<NewTask>): void {
	useNewTasksStore.setState(state => {
		const task = state.tasks[id];
		return task ? { tasks: { ...state.tasks, [id]: { ...task, ...change(task) } } } : state;
	});
}

function setStep(id: string, step: NewTaskStepId, next: NewTaskStepState): void {
	const now = Date.now();
	patch(id, task => ({
		wait: undefined,
		steps: task.steps.map(entry =>
			entry.id !== step
				? entry
				: next === "running"
					? { id: step, state: next, startedAt: now }
					: { ...entry, state: next, ...(next === "done" ? { endedAt: now } : {}) },
		),
	}));
}

/** A failed answer as the error it carries. */
function answered<T>(response: RpcResponse): T {
	if (!response.success) throw response;
	return response.data as T;
}

/** The first prompt with its files: pictures attach, paths become mentions, a file the computer cannot read inlines. */
async function firstMessage(
	task: NewTask,
	tabId: string,
	cwd: string,
): Promise<{ text: string; images: ImageContent[] }> {
	const { prompt, files, device } = task.request;
	if (files.length === 0) return { text: prompt, images: [] };
	const intake = await intakeComposerFiles(files, {
		cwd,
		pathFor: file => window.omp.fs.pathForFile(file),
		remote: device !== undefined,
		sendToHost: async file => {
			const sent = await window.omp.fs.uploadToHost(tabId, file);
			if (sent.ok && sent.path) return sent.path;
			throw new Error(sent.error ?? translate("newTask.fileNotSent", { name: file.name }));
		},
	});
	for (const rejected of intake.rejected)
		toast({
			variant: "warning",
			message: rejected.message ?? translate("newTask.fileNotSent", { name: rejected.name }),
		});
	const images = await Promise.all(
		intake.images.map(file => fileToImage(file, webRuntime() ? undefined : window.omp.fs.imageToModel)),
	);
	const text = [
		prompt,
		intake.mentions.join(" "),
		...intake.texts.map(file => fileTextAttachment(file.name, file.content)),
	]
		.filter(part => part.trim())
		.join("\n\n");
	return { text, images: images.map(image => image.content) };
}

async function runStep(id: string, step: NewTaskStepId): Promise<void> {
	const rpc = rpcs.get(id);
	const task = useNewTasksStore.getState().tasks[id];
	if (!rpc || !task) return;
	const { request } = task;
	switch (step) {
		case "fetch":
			// Its answer is only told with the create's; a failed fetch never fails the task (the create says why).
			await rpc.worktreePrefetch(request.baseCwd).catch(() => undefined);
			return;
		case "name": {
			const prompt = request.prompt.trim();
			const answer = prompt ? await rpc.worktreeNameSuggest(prompt).catch(() => null) : null;
			const title = answer?.success ? (answer.data as { title?: string | null } | undefined)?.title : null;
			const suggested = title ? worktreeSlug(title) : "";
			patch(id, () => (suggested ? { name: suggested } : { name: `task-${id.slice(0, 4)}`, placeholderName: true }));
			return;
		}
		case "create": {
			const name = task.name ?? request.name;
			const made = answered<RpcWorktreeCreateResult>(
				await rpc.command({
					type: "worktree_create",
					name,
					baseCwd: request.baseCwd,
					baseRef: request.baseRef,
					...(request.branchPrefix ? { branchPrefix: request.branchPrefix } : {}),
					// Started again on the same work item, its branch is still there: the worktree takes it back.
					...(request.branch ? { branch: { name: request.branch, mode: "reuse" as const } } : {}),
					...(request.sparse ? { sparse: request.sparse } : {}),
					requestId: id,
					prepare: false,
				}),
			);
			patch(id, () => ({ made }));
			return;
		}
		case "prepare": {
			const made = task.made;
			if (!made) return;
			const prepared = answered<RpcWorktreePrepared>(
				await rpc.command({ type: "worktree_prepare", baseCwd: made.baseCwd, path: made.path, requestId: id }),
			);
			const whole = { ...made, ...prepared };
			patch(id, () => ({ made: whole }));
			announced?.(whole);
			return;
		}
		case "start": {
			const made = task.made;
			const cwd = made?.path ?? request.baseCwd;
			let tabId = task.tabId;
			if (!tabId || !useTabsStore.getState().tabs.some(tab => tab.id === tabId)) {
				const opened = await useTabsStore.getState().openTab({
					cwd,
					...(request.device === undefined ? {} : { device: request.device }),
					...(made
						? {
								worktree: {
									name: worktreeSlug(task.name ?? request.name),
									branch: made.branch,
									baseCwd: made.baseCwd,
									path: made.path,
								},
							}
						: {}),
				});
				if (!opened) throw new Error(translate("worktree.openFailed", { path: cwd }));
				tabId = opened;
				patch(id, () => ({ tabId: opened }));
			}
			if (task.placeholderName && made) renameOnFirstTitle(tabId, made, request.branchPrefix);
			if (!request.prompt.trim() && request.files.length === 0) return;
			const runtime = ensureTabRuntime(tabId);
			const { text, images } = await firstMessage(task, tabId, cwd);
			// The task's id rides every try, so a Retry after a lost answer reaches omp once (main's delivery-ledger.ts).
			const send = () => runtime.command({ type: "prompt", message: text, images, deliveryId: id });
			// A tab just opened answers `sidecar_not_ready` until its omp is up: that waits, as the outbox does, a bounded
			// number of times (a tab that reads ready and still refuses fails the step, which Retry sends again).
			for (let tries = 1; ; tries++) {
				await whenTabReady(tabId);
				const response = await send();
				if (response.success || response.code !== "sidecar_not_ready" || tries >= 20) {
					answered(response);
					return;
				}
			}
		}
	}
}

/** Resolves once tab `tabId` reads ready (or running); rejects when it is gone, exited or failed. */
function whenTabReady(tabId: string): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const check = (tabs: readonly SessionTab[]): boolean => {
		const tab = tabs.find(entry => entry.id === tabId);
		if (tab?.status === "ready" || tab?.status === "running") resolve();
		else if (!tab || tab.status === "exited" || tab.status === "error")
			reject(new Error(translate("newTask.sessionDidNotStart")));
		else return false;
		return true;
	};
	if (!check(useTabsStore.getState().tabs)) {
		const unsubscribe = useTabsStore.subscribe(state => {
			if (check(state.tabs)) unsubscribe();
		});
	}
	return promise;
}

/**
 * FS91 (Orca `first-work-branch-rename.ts:95-134,185-271`): a worktree named only by the fallback takes a name for its
 * session's first title once there is one (the title model, in English: `worktree_name_suggest`), renamed by the tab's
 * own computer while nothing published the branch (main refuses once it has an upstream or a remote copy, and points
 * the tab's record at the new name). The folder keeps its name.
 */
function renameOnFirstTitle(tabId: string, made: RpcWorktreeCreateResult, branchPrefix: string | undefined): void {
	const prefix = branchPrefix ?? GUI_WORKTREE_BRANCH_PREFIX;
	if (!made.branch.startsWith(prefix)) return;
	const unsubscribe = useTabsStore.subscribe(state => {
		const tab = state.tabs.find(entry => entry.id === tabId);
		if (tab && !tab.title?.trim()) return;
		unsubscribe();
		if (!tab?.title) return;
		const rpc = createTabRpc(ensureTabRuntime(tabId).command);
		void rpc
			.worktreeNameSuggest(tab.title)
			.then(answer => {
				const title = answer.success ? (answer.data as { title?: string | null } | undefined)?.title : null;
				const slug = title ? worktreeSlug(title) : "";
				return slug ? rpc.worktreeRenameBranch(made.branch, `${prefix}${slug}`) : undefined;
			})
			.catch(() => undefined);
	});
}

/** What the sheet toasts once a worktree is prepared (`announcePreparation`); set by the sheet's module. */
let announced: ((made: RpcWorktreeCreateResult) => void) | undefined;
export function setNewTaskAnnouncer(announce: (made: RpcWorktreeCreateResult) => void): void {
	announced = announce;
}

async function run(id: string): Promise<void> {
	for (;;) {
		const task = useNewTasksStore.getState().tasks[id];
		if (task?.status !== "running") return;
		const next = task.steps.find(step => step.state !== "done");
		if (!next) {
			// Its session's row takes over.
			useNewTasksStore.setState(state => {
				const { [id]: _done, ...rest } = state.tasks;
				return { tasks: rest };
			});
			rpcs.delete(id);
			return;
		}
		setStep(id, next.id, "running");
		let stopWait: (() => void) | undefined;
		try {
			if (next.id === "create" || next.id === "prepare") {
				stopWait = window.omp.events.onWorktreeWait(({ requestId, step, wait }) => {
					if (requestId === id && step === next.id) patch(id, () => ({ wait: wait ?? undefined }));
				});
			}
			await runStep(id, next.id);
			setStep(id, next.id, "done");
		} catch (error) {
			setStep(id, next.id, "failed");
			patch(id, () => ({ status: "failed", error: inlineFailure(error, translate("newTask.failed")) }));
			return;
		} finally {
			stopWait?.();
		}
	}
}

/** Start a new task on `rpc` (a tab of the computer it runs on); answers its id. */
export function startNewTask(request: NewTaskRequest, rpc: TabRpc): string {
	const id = crypto.randomUUID();
	rpcs.set(id, rpc);
	const name = request.name.trim();
	const task: NewTask = {
		id,
		request,
		steps: stepsFor(request).map(step => ({ id: step, state: "pending" })),
		status: "running",
		startedAt: Date.now(),
		...(name ? { name } : {}),
	};
	useNewTasksStore.setState(state => ({ tasks: { ...state.tasks, [id]: task } }));
	void run(id);
	return id;
}

/** Run a failed task again from the step that failed. */
export function retryNewTask(id: string): void {
	const task = useNewTasksStore.getState().tasks[id];
	if (task?.status !== "failed") return;
	patch(id, current => ({
		status: "running",
		error: undefined,
		steps: current.steps.map(step => (step.state === "failed" ? { id: step.id, state: "pending" } : step)),
	}));
	void run(id);
}

/** Forget a failed task: what it already made (a worktree) stays, as a failed create's row does in Orca. */
export function dismissNewTask(id: string): void {
	useNewTasksStore.setState(state => {
		const { [id]: _gone, ...rest } = state.tasks;
		return { tasks: rest };
	});
	rpcs.delete(id);
}
