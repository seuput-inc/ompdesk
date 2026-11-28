/**
 * A new task's row sits in the list of the computer it runs on (a paired computer's task in that computer's section,
 * never in this computer's own list), and a failed one says what refused it.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { I18nProvider, loadLocale, setLanguageOverride } from "../../../lib/i18n";
import { type NewTask, useNewTasksStore } from "../../../stores/new-tasks";
import { NewTaskRows } from "./NewTaskRows";

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

let root: Root | undefined;

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
	useNewTasksStore.getState().reset();
});

function task(id: string, device: string | undefined, error?: NewTask["error"]): NewTask {
	return {
		id,
		request: {
			baseCwd: "/work/project",
			...(device === undefined ? {} : { device }),
			worktree: true,
			name: id,
			baseRef: "no-such-base",
			prompt: "",
			files: [],
		},
		steps: [{ id: "create", state: "failed" }],
		status: "failed",
		...(error ? { error } : {}),
		name: id,
		startedAt: Date.now(),
	};
}

async function mount(node: React.ReactNode): Promise<void> {
	root ??= createRoot(document.body as unknown as globalThis.Element);
	await act(async () => root?.render(<I18nProvider>{node}</I18nProvider>));
}

const shown = () => [...document.querySelectorAll("[data-new-task]")].map(row => row.getAttribute("data-new-task"));

it("lists a paired computer's task in that computer's project group, not in this computer's list", async () => {
	useNewTasksStore.setState({ tasks: { here: task("here", undefined), there: task("there", "pc-b") } });
	await mount(<NewTaskRows except={[]} sections={["pc-b"]} />);
	expect(shown()).toEqual(["here"]);
	await mount(<NewTaskRows cwd="/work/project" device="pc-b" />);
	expect(shown()).toEqual(["there"]);
	await mount(<NewTaskRows device="pc-b" except={["/work/project"]} />);
	expect(shown()).toEqual([]);
	// A section whose host is offline lists every task of its host.
	await mount(<NewTaskRows device="pc-b" />);
	expect(shown()).toEqual(["there"]);
});

it("keeps a task of a computer the sidebar has no section for in this computer's list, so it can be closed", async () => {
	useNewTasksStore.setState({ tasks: { here: task("here", undefined), there: task("there", "pc-gone") } });
	await mount(<NewTaskRows except={["/work/project"]} sections={["pc-b"]} />);
	expect(shown()).toEqual(["there"]);
});

it("says what refused a failed task, its headline in the tooltip", async () => {
	useNewTasksStore.setState({
		tasks: {
			failed: task("failed", undefined, {
				message: "Couldn't start the task",
				cause: new Error("fatal: invalid reference: no-such-base"),
			}),
		},
	});
	await mount(<NewTaskRows cwd="/work/project" />);
	const row = document.querySelector("[data-new-task]");
	expect(row?.textContent).toContain("fatal: invalid reference: no-such-base");
	expect(row?.getAttribute("title")).toBe("Couldn't start the task\nfatal: invalid reference: no-such-base");
});

it("shows the disk requirement on the waiting row and the current step on the other", async () => {
	const running = (id: string): NewTask => ({
		...task(id, undefined),
		status: "running",
		steps: [{ id: "prepare", state: "running" }],
	});
	const second = running("second");
	useNewTasksStore.setState({
		tasks: { first: running("first"), second: { ...second, wait: { reason: "disk", free: 1024, need: 2048 } } },
	});
	await mount(<NewTaskRows cwd="/work/project" />);
	const text = (id: string) => document.querySelector(`[data-new-task="${id}"]`)?.textContent;
	expect(text("first")).toContain("Preparing");
	expect(text("second")).toContain("Waiting for disk space (1.0 KB free, 2.0 KB needed)");
	await loadLocale("ko");
	try {
		await act(async () => setLanguageOverride("ko"));
		expect(text("first")).toContain("준비하는 중");
		expect(text("second")).toContain("디스크 공간 대기 중");
	} finally {
		await act(async () => setLanguageOverride(null));
	}
	await act(async () => useNewTasksStore.setState(state => ({ tasks: { ...state.tasks, second } })));
	expect(text("second")).toContain("Preparing");
	expect(text("second")).not.toContain("Waiting");
});
