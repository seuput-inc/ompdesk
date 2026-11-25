// A .mjs on purpose: it imports bridge area modules, whose `@oh-my-pi/*` type imports the repo's tsc cannot resolve
// (tsconfig includes only .ts/.tsx).
import { describe, expect, it, vi } from "vitest";

// omp without `buildJobTree`: the module is there, the export is gone (as omp 19 dropped two AgentSession members).
vi.mock("@oh-my-pi/pi-coding-agent/modes/view-model/overlays/job-tree", () => ({}));

const { methods } = await import("../../resources/gui-bridge/composer");

/**
 * One capability per action: an omp without one internal refuses only the method that uses it, and every other action
 * of the old `composer` feature still answers.
 */
function envWith(session) {
	return {
		pi: { pi: { VERSION: "19.0.0" } },
		session: () => session,
		context: () => {
			throw new Error("no context");
		},
		emit: () => {},
	};
}

/** What the session-only composer actions call, without `abortCompaction`. */
function sessionWithoutAbortCompaction() {
	const queued = { steering: ["later"], followUp: [] };
	return {
		getAsyncJobTree: () => ({ jobs: [] }),
		inspectAsyncJob: () => undefined,
		executePython: async () => ({ output: "", exitCode: 0, cancelled: false, truncated: false }),
		abortEval() {},
		getPrewalkState: () => undefined,
		disarmPrewalk() {},
		cancelAsyncJob: id => id === "job-1",
		cycleModel: async () => ({ model: { id: "m0" } }),
		getQueuedMessages: () => ({ steering: [...queued.steering], followUp: [...queued.followUp] }),
		popLastQueuedMessage: () => {
			const text = queued.steering.pop();
			return text ? { text, images: [] } : undefined;
		},
	};
}

describe("composer actions on an omp missing one internal", () => {
	it("refuses only the action whose session member is gone, naming that action", async () => {
		const env = envWith(sessionWithoutAbortCompaction());
		const refused = await methods["composer.abort_maintenance"]({}, env).catch(error => error);
		expect(refused).toMatchObject({ code: "unsupported_omp" });
		expect(refused.message).toMatch(/Cancel compaction \(missing AgentSession\.abortCompaction\)/);
		expect(refused.message).not.toMatch(/Prewalk|Python|queued|jobs/i);

		await expect(methods["composer.abort_eval"]({}, env)).resolves.toBeNull();
		await expect(methods["composer.prewalk_armed"]({}, env)).resolves.toEqual({ armed: false });
		await expect(methods["composer.cycle_model_backward"]({}, env)).resolves.toEqual({ model: { id: "m0" } });
		await expect(methods["composer.dequeue"]({}, env)).resolves.toEqual({ text: "later", images: [], mode: "steer" });
	});

	it("refuses only the action whose stock export is gone, and its sibling job action still answers", async () => {
		const env = envWith(sessionWithoutAbortCompaction());
		await expect(methods["composer.jobs"]({}, env)).rejects.toMatchObject({
			code: "unsupported_omp",
			message: expect.stringMatching(/missing @oh-my-pi\/pi-coding-agent\/modes\/view-model\/overlays\/job-tree#buildJobTree/),
		});
		await expect(methods["composer.cancel_job"]({ id: "job-1" }, env)).resolves.toEqual({ cancelled: true });
	});
});
