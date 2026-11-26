/**
 * The new task sheet: the branch it previews and asks for carries the Worktree branch prefix from Settings
 * (`worktreeBranchPrefix`), else omp/gui/; it prefetches the remote default branch when it opens; a submit hands the
 * task to `stores/new-tasks.ts`, whose create carries the task's id as its request id (a Retry after a failure sends
 * the same one) and leaves the seed and setup to its own `worktree_prepare` step; and it toasts what the base fetch
 * brought.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionRpcClient } from "../../../shared/rpc-client";
import type { RpcCommand, RpcResponse } from "../../../shared/rpc-types";
import { WORKTREE_BRANCH_PREFIX_PREF } from "../../../shared/worktree-branch";
import { I18nProvider, translate } from "../../lib/i18n";
import { retryNewTask, startNewTask, stepsFor, useNewTasksStore } from "../../stores/new-tasks";
import { useSessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { useToastStore } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { announcePreparation, WorktreeDialog } from "./WorktreeDialog";

const { document, window, Event, CustomEvent, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	CustomEvent,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
});
const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.focus !== "function") elementPrototype.focus = () => {};

let container: HTMLElement | undefined;
let root: Root | undefined;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	container?.remove();
	useUiStore.getState().closeWorktreeDialog();
	useTabsStore.getState().reset();
	useNewTasksStore.getState().reset();
});

/** The props React gave an element (linkedom has no input events of its own). */
function reactProps(element: Element): Record<string, (event: object) => void> {
	const key = Object.keys(element).find(name => name.startsWith("__reactProps$"));
	return key ? (element as unknown as Record<string, Record<string, (event: object) => void>>)[key] : {};
}

const MADE = { path: "/wt/gui-login-abc1234", branch: "omp/gui/login", baseCwd: "/home/u/app" };

/** A tab client that answers the worktree commands as main does, failing `worktree_create` `failCreates` times. */
function fakeRpc(failCreates = 0) {
	const commands: RpcCommand[] = [];
	let failures = failCreates;
	const rpc = createSessionRpcClient(async (command: RpcCommand): Promise<RpcResponse> => {
		commands.push(command);
		const ok = (data: unknown): RpcResponse => ({ type: "response", command: command.type, success: true, data });
		if (command.type === "worktree_create") {
			if (failures-- > 0)
				return { type: "response", command: command.type, success: false, error: "index.lock exists" };
			return ok(MADE);
		}
		if (command.type === "worktree_prepare") return ok({});
		if (command.type === "worktree_sparse_presets") return ok([]);
		if (command.type === "worktree_setup_draft" || command.type === "worktree_prefetch") return ok(null);
		return { type: "response", command: command.type, success: false, error: "not under test" };
	});
	return { rpc, commands };
}

async function mount(prefix: unknown) {
	const { rpc, commands } = fakeRpc();
	Object.assign(window, {
		omp: {
			rpc,
			prefs: { get: vi.fn(async (key: string) => (key === WORKTREE_BRANCH_PREFIX_PREF ? prefix : undefined)) },
			events: { onSessionsChanged: () => () => {} },
			sessions: { listShared: async () => ({ version: 1, sessions: [] }) },
		},
	});
	const openTab = vi.fn(async () => "t2");
	useTabsStore.setState({
		tabs: [{ kind: "agent", id: "a", cwd: "/home/u/app", status: "ready", unreadDone: false }],
		activeTabId: "a",
		openTab,
	});
	useSessionStore.setState({ status: "ready", cwd: "/home/u/app" });
	useUiStore.getState().openWorktreeDialog();
	container = document.createElement("div");
	document.body.appendChild(container);
	const mounted = createRoot(container);
	root = mounted;
	await act(async () => {
		mounted.render(
			<I18nProvider>
				<WorktreeDialog />
			</I18nProvider>,
		);
	});
	await flush();
	return { commands, openTab };
}

async function typeName(value: string): Promise<void> {
	const input = document.querySelector("input:not([type=radio]):not([type=checkbox]):not([type=file])");
	if (!input) throw new Error("no name field");
	await act(async () => reactProps(input).onChange?.({ target: { value } }));
	await flush();
}

async function submit(): Promise<void> {
	const form = document.querySelector("form");
	if (!form) throw new Error("no form");
	await act(async () => reactProps(form).onSubmit?.({ preventDefault: () => {} }));
	await flush();
	await flush();
}

describe("the new task sheet", () => {
	it("previews and creates the branch under the prefix set in Settings, then prepares and opens it", async () => {
		const { commands, openTab } = await mount("alice/");
		await typeName("Login");
		expect(document.body.textContent).toContain(translate("worktree.branchPreview", { branch: "alice/login" }));
		await submit();
		expect(useUiStore.getState().worktreeDialog).toBeNull();
		expect(commands.filter(command => command.type === "worktree_create")).toEqual([
			{
				type: "worktree_create",
				name: "Login",
				baseCwd: "/home/u/app",
				baseRef: "HEAD",
				branchPrefix: "alice/",
				requestId: expect.any(String),
				prepare: false,
			},
		]);
		expect(commands.filter(command => command.type === "worktree_prepare")).toEqual([
			{ type: "worktree_prepare", baseCwd: MADE.baseCwd, path: MADE.path },
		]);
		expect(openTab).toHaveBeenCalledWith({
			cwd: MADE.path,
			worktree: { name: "login", branch: MADE.branch, baseCwd: MADE.baseCwd, path: MADE.path },
		});
		expect(useNewTasksStore.getState().tasks).toEqual({});
	});

	it("falls back to omp/gui/ when no prefix is set, and sends none", async () => {
		const { commands } = await mount(undefined);
		await typeName("Login");
		expect(document.body.textContent).toContain(translate("worktree.branchPreview", { branch: "omp/gui/login" }));
		await submit();
		const [create] = commands.filter(command => command.type === "worktree_create");
		expect(create).toMatchObject({ type: "worktree_create", name: "Login" });
		expect(create).not.toHaveProperty("branchPrefix");
	});

	it("prefetches the folder's remote default branch when it opens", async () => {
		const { commands } = await mount(undefined);
		expect(commands.filter(command => command.type === "worktree_prefetch")).toEqual([
			{ type: "worktree_prefetch", baseCwd: "/home/u/app" },
		]);
	});
});

describe("a new task's steps", () => {
	const request = {
		baseCwd: "/home/u/app",
		worktree: true,
		name: "login",
		baseRef: "HEAD",
		prompt: "",
		files: [],
	};

	it("names the worktree from the prompt only when no name was typed, and fetches only for the default branch", () => {
		expect(stepsFor(request)).toEqual(["create", "prepare", "start"]);
		expect(stepsFor({ ...request, name: "", prompt: "Fix login", baseRef: "default" })).toEqual([
			"fetch",
			"name",
			"create",
			"prepare",
			"start",
		]);
		expect(stepsFor({ ...request, worktree: false })).toEqual(["start"]);
	});

	it("keeps a failed create on its row, and a Retry sends the same request id and goes on", async () => {
		const { rpc, commands } = fakeRpc(1);
		useTabsStore.setState({ openTab: vi.fn(async () => "t2") });
		const id = startNewTask(request, rpc);
		await flush();
		const failed = useNewTasksStore.getState().tasks[id];
		expect(failed?.status).toBe("failed");
		expect(failed?.steps.map(step => step.state)).toEqual(["failed", "pending", "pending"]);
		retryNewTask(id);
		await flush();
		await flush();
		const ids = commands.flatMap(command => (command.type === "worktree_create" ? [command.requestId] : []));
		expect(ids).toEqual([id, id]);
		expect(useNewTasksStore.getState().tasks[id]).toBeUndefined();
	});
});

describe("announcePreparation", () => {
	it("toasts what the fetch brought even when nothing else was prepared, and warns when it could not fetch", () => {
		useToastStore.setState({ toasts: [] });
		const made = { path: "/wt/x", branch: "omp/gui/x", baseCwd: "/home/u/app" };
		announcePreparation(
			{ ...made, base: { ref: "origin/main", fetched: true, behind: 3, subjects: ["a", "b", "c"] } },
			translate,
		);
		announcePreparation(
			{ ...made, base: { ref: "origin/main", fetched: false, behind: 0, subjects: [], error: "no route" } },
			translate,
		);
		expect(
			useToastStore.getState().toasts.map(({ variant, message, detail }) => ({ variant, message, detail })),
		).toEqual([
			{
				variant: "info",
				message: translate("worktree.baseFetched", { ref: "origin/main", count: 3 }),
				detail: "a\nb\nc",
			},
			{
				variant: "warning",
				message: translate("worktree.baseFetchFailed", { ref: "origin/main" }),
				detail: "no route",
			},
		]);
	});
});
