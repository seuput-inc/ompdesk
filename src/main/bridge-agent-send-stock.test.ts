import { existsSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { wrapAgentMessage } from "../shared/agent-control";
import {
	atEnd,
	CARD,
	type Frame,
	HOLD,
	type Omp,
	type Provider,
	runCleanups,
	STEPS,
	startOmp,
	startProvider,
} from "./bridge-agent-mail-stock-harness";
import { INSTALLED_OMP as omp } from "./test-bridge-probe";

afterAll(runCleanups);

/**
 * What a message another session's agent sends (`ompdesk_session_send`: stock `prompt` with the `streamingBehavior`
 * main chose) does to a receiver in the middle of a turn, on the installed omp with a scripted provider on loopback (no
 * model spend). The turn takes three steps, one shell call each, then replies.
 *
 * Reported on 12 Nov 2026: what agents sent each other was not delivered right away, and the person pressed 지금 추가
 * 지시 on it. The sender had asked for `follow_up`, which stock holds in the receiver's queue, where the person sees it,
 * until the turn's last reply; a steer is read at the next step. So main steers whatever reaches a running session the
 * sender did not open (`AgentControl.#handSend`), except while that session shows the person a card: stock reads a
 * message main sends as the person's, and closes the card for it.
 */
async function busyOmp(): Promise<{ provider: Provider; session: Omp }> {
	const provider = await startProvider();
	provider.release();
	atEnd(() => provider.close());
	const session = await startOmp(provider);
	// Stock writes the session file with its first reply; the turn under test comes after it.
	await session.send({ type: "prompt", message: "first" });
	await expect.poll(() => ended(session.frames), { timeout: 30_000 }).toBe(1);
	await session.send({ type: "prompt", message: STEPS });
	await expect
		.poll(
			() => session.frames.some(frame => frame.type === "tool_execution_start" && frame.toolCallId === "call_s1"),
			{
				timeout: 30_000,
			},
		)
		.toBe(true);
	return { provider, session };
}

const ended = (frames: readonly Frame[]) => frames.filter(frame => frame.type === "agent_end").length;

/** The first main-agent request that carries the message. */
const firstWith = (provider: Provider, text: string) => provider.bodies.findIndex(body => body.includes(text));

describe.skipIf(!existsSync(omp))("a message another session sends to a busy receiver on stock omp", () => {
	it("as a steer, is read at the next step of the same turn, and no call of the turn is skipped", async () => {
		const { provider, session } = await busyOmp();
		const answer = await session.send({
			type: "prompt",
			message: wrapAgentMessage("steer-now", "Other"),
			streamingBehavior: "steer",
		});
		expect(answer.success).toBe(true);
		await expect.poll(() => ended(session.frames), { timeout: 30_000 }).toBe(2);

		// Requests: the first prompt's reply, then the turn's first step, then the one that carries the message.
		expect(firstWith(provider, "steer-now")).toBe(2);
		// It rode a step the turn made anyway: three steps and the reply, no extra request.
		expect(provider.turns).toBe(5);
		const ends = session.frames.filter(frame => frame.type === "tool_execution_end");
		expect(ends.map(frame => frame.toolCallId)).toEqual(["call_s1", "call_s2", "call_s3"]);
		expect(ends.map(frame => frame.isError)).toEqual([false, false, false]);
		expect(session.frames.some(frame => frame.type === "queue_update" && frame.followUp?.length)).toBe(false);
	}, 180_000);

	it("as a follow-up, waits in the receiver's queue until the turn's last reply", async () => {
		const { provider, session } = await busyOmp();
		await session.send({
			type: "prompt",
			message: wrapAgentMessage("follow-later", "Other"),
			streamingBehavior: "followUp",
		});
		// What the person sees meanwhile: one message waiting in that session's queue.
		expect((await session.send({ type: "get_state" })).data).toMatchObject({ queuedMessageCount: 1 });
		await expect.poll(() => ended(session.frames), { timeout: 30_000 }).toBe(2);

		// Read only after the turn's three steps and its reply.
		expect(firstWith(provider, "follow-later")).toBe(5);
		expect(provider.turns).toBe(6);
	}, 180_000);
});

/**
 * Several messages from other sessions reaching one busy receiver (18 Nov 2026, the hub on 0.133.0: six messages from
 * one session sat as "다음 단계 뒤 7" in its queue, and each then cost a model request of its own). Stock's steering
 * queue hands over one steer per step boundary (`steeringMode` one-at-a-time, the default); its `aside` queue hands over
 * every aside waiting there at once and sits in no queue the person sees. The bridge's `agent_control.aside` is what
 * main sends a busy receiver.
 */
describe.skipIf(!existsSync(omp))("several messages other sessions send one busy receiver on stock omp", () => {
	const queued = (frames: readonly Frame[]) =>
		Math.max(0, ...frames.filter(frame => frame.type === "queue_update").map(frame => frame.steering?.length ?? 0));
	const firsts = (provider: Provider, prefix: string) => [1, 2, 3].map(n => firstWith(provider, `${prefix}-${n}`));

	/** A receiver in the middle of one long reply: its model request is held until `release`, no tool step. */
	async function replying(): Promise<{ provider: Provider; session: Omp }> {
		const provider = await startProvider();
		atEnd(() => provider.close());
		const session = await startOmp(provider);
		await session.send({ type: "prompt", message: HOLD });
		await provider.held;
		return { provider, session };
	}

	async function steer(session: Omp, text: string): Promise<void> {
		const message = wrapAgentMessage(text, "Other");
		expect((await session.send({ type: "prompt", message, streamingBehavior: "steer" })).success).toBe(true);
	}
	async function aside(session: Omp, text: string): Promise<void> {
		const message = wrapAgentMessage(text, "Other");
		expect(await session.bridge.request("agent_control.aside", { message })).toEqual({});
	}

	it("as steers during one reply with no tool step, wait in the person's queue and cost one model request each", async () => {
		const { provider, session } = await replying();
		for (const n of [1, 2, 3]) await steer(session, `steer-${n}`);
		expect(queued(session.frames)).toBe(3);
		provider.release();
		await expect.poll(() => ended(session.frames), { timeout: 30_000 }).toBe(1);
		// Request 0 is the held reply; each steer then rode a request of its own.
		expect(firsts(provider, "steer")).toEqual([1, 2, 3]);
		expect(provider.turns).toBe(4);
	}, 180_000);

	it("as asides during one reply with no tool step, are read together in one request and never queued", async () => {
		const { provider, session } = await replying();
		for (const n of [1, 2, 3]) await aside(session, `aside-${n}`);
		provider.release();
		await expect.poll(() => ended(session.frames), { timeout: 30_000 }).toBe(1);
		expect(firsts(provider, "aside")).toEqual([1, 1, 1]);
		expect(provider.turns).toBe(2);
		expect(queued(session.frames)).toBe(0);
		expect(session.frames.some(frame => frame.type === "queue_update" && frame.followUp?.length)).toBe(false);
	}, 180_000);

	it("as steers during a turn of tool steps, are read one per step", async () => {
		const { provider, session } = await busyOmp();
		for (const n of [1, 2, 3]) await steer(session, `step-steer-${n}`);
		await expect.poll(() => ended(session.frames), { timeout: 30_000 }).toBe(2);
		expect(firsts(provider, "step-steer")).toEqual([2, 3, 4]);
		expect(provider.turns).toBe(5);
	}, 180_000);

	it("as asides during a turn of tool steps, are read together at the next step, and no call is skipped", async () => {
		const { provider, session } = await busyOmp();
		for (const n of [1, 2, 3]) await aside(session, `step-aside-${n}`);
		await expect.poll(() => ended(session.frames), { timeout: 30_000 }).toBe(2);
		expect(firsts(provider, "step-aside")).toEqual([2, 2, 2]);
		expect(provider.turns).toBe(5);
		const ends = session.frames.filter(frame => frame.type === "tool_execution_end");
		expect(ends.map(frame => [frame.toolCallId, frame.isError])).toEqual([
			["call_s1", false],
			["call_s2", false],
			["call_s3", false],
		]);
		expect(queued(session.frames)).toBe(0);
	}, 180_000);

	it("sends an idle receiver nothing and says so, so main starts its turn with a prompt", async () => {
		const provider = await startProvider();
		provider.release();
		atEnd(() => provider.close());
		const session = await startOmp(provider);
		const message = wrapAgentMessage("idle-aside", "Other");
		expect(await session.bridge.request("agent_control.aside", { message })).toEqual({ idle: true });
		expect(provider.turns).toBe(0);
	}, 180_000);
});

describe.skipIf(!existsSync(omp))("a message another session sends while the receiver shows the person a card", () => {
	const isCard = (frame: Frame) => frame.type === "extension_ui_request" && frame.method === "select";
	const askResult = (frames: readonly Frame[]) =>
		JSON.stringify(
			frames.find(frame => frame.type === "tool_execution_end" && frame.toolCallId === "call_ask")?.result,
		);

	async function cardOpen(): Promise<{ provider: Provider; session: Omp; card: Frame }> {
		const provider = await startProvider();
		provider.release();
		atEnd(() => provider.close());
		const session = await startOmp(provider);
		await session.send({ type: "prompt", message: CARD });
		await expect.poll(() => session.frames.some(isCard), { timeout: 30_000 }).toBe(true);
		return { provider, session, card: session.frames.find(isCard) as Frame };
	}

	it("as a steer, closes the card, and the model reads the message instead of the person's answer", async () => {
		const { provider, session, card } = await cardOpen();
		await session.send({
			type: "prompt",
			message: wrapAgentMessage("steer-card", "Other"),
			streamingBehavior: "steer",
		});
		await expect.poll(() => ended(session.frames), { timeout: 30_000 }).toBe(1);
		expect(
			session.frames.some(
				frame => frame.type === "extension_ui_request" && frame.method === "cancel" && frame.targetId === card.id,
			),
		).toBe(true);
		expect(askResult(session.frames)).toContain("Ask interrupted by message");
		expect(firstWith(provider, "steer-card")).toBe(1);
	}, 180_000);

	it("as a follow-up, leaves the card to the person and is read after the turn their answer goes on with", async () => {
		const { provider, session, card } = await cardOpen();
		await session.send({
			type: "prompt",
			message: wrapAgentMessage("follow-card", "Other"),
			streamingBehavior: "followUp",
		});
		session.write({ type: "extension_ui_response", id: card.id, value: card.options?.[0] });
		await expect.poll(() => ended(session.frames), { timeout: 30_000 }).toBe(1);
		expect(session.frames.some(frame => frame.type === "extension_ui_request" && frame.method === "cancel")).toBe(
			false,
		);
		expect(askResult(session.frames)).not.toContain("interrupted");
		// Requests: the card, the answer, then the message.
		expect(firstWith(provider, "follow-card")).toBe(2);
	}, 180_000);

	it("as an aside, leaves the card to the person and is read at the step right after their answer", async () => {
		const { provider, session, card } = await cardOpen();
		const message = wrapAgentMessage("aside-card", "Other");
		expect(await session.bridge.request("agent_control.aside", { message })).toEqual({});
		session.write({ type: "extension_ui_response", id: card.id, value: card.options?.[0] });
		await expect.poll(() => ended(session.frames), { timeout: 30_000 }).toBe(1);
		expect(session.frames.some(frame => frame.type === "extension_ui_request" && frame.method === "cancel")).toBe(
			false,
		);
		expect(askResult(session.frames)).not.toContain("interrupted");
		// Requests: the card, then the answer together with the message.
		expect(firstWith(provider, "aside-card")).toBe(1);
	}, 180_000);
});
