import { existsSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { wrapAgentMessage } from "../shared/agent-control";
import {
	atEnd,
	type Frame,
	HELD_SHELL,
	mail,
	type Omp,
	type Provider,
	runCleanups,
	startOmp,
	startProvider,
	TOOL,
} from "./bridge-agent-mail-stock-harness";
import { INSTALLED_OMP as omp } from "./test-bridge-probe";

afterAll(runCleanups);

/**
 * A message reaches a working session now, not when the shell command it runs ends (the owner, 11, 14 and 18 Nov
 * 2026: "타임아웃 명령어 걸어두고 있으면 내 메세지가 대기열에 들어간다고"; 15 Nov: "지금지시 말고는 없애버려"). On the
 * installed omp with a scripted provider on loopback: the turn sits in `bash` `sleep 300`. The person's steer made stock
 * background the command at once; another session's message (the bridge's `agent_control.aside`) and a report that
 * asks for a turn waited for the command or its 60 s auto-background (58.6 s measured on omp 18.22.2), because a plain
 * aside cuts only an interruptible `wait`. A message that arrives during a long reply is read at that reply's end, the
 * first point stock can take it, and the shell call of that reply backgrounds at once instead of holding it.
 *
 * "Backgrounded early to handle an incoming message" is stock's text for a shell that its cooperative steering signal
 * moved to the background; one the 60 s threshold moved says only "Backgrounded as job".
 */
const EARLY = "Backgrounded early to handle an incoming message";

const ended = (frames: readonly Frame[]) => frames.filter(frame => frame.type === "agent_end").length;

/** The result text of tool call `id`, once it ended. */
function resultOf(frames: readonly Frame[], id: string): string | undefined {
	const end = frames.find(frame => frame.type === "tool_execution_end" && frame.toolCallId === id);
	return end ? JSON.stringify(end.result) : undefined;
}

async function started(): Promise<{ provider: Provider; session: Omp }> {
	const provider = await startProvider();
	atEnd(() => provider.close());
	const session = await startOmp(provider);
	return { provider, session };
}

/** A receiver standing in `bash` `sleep 300` (call `call_1`), after a first turn that wrote its session file. */
async function inShell(): Promise<{ provider: Provider; session: Omp }> {
	const { provider, session } = await started();
	provider.release();
	await session.send({ type: "prompt", message: "first" });
	await expect.poll(() => ended(session.frames), { timeout: 30_000 }).toBe(1);
	await session.send({ type: "prompt", message: TOOL });
	await expect
		.poll(
			() => session.frames.some(frame => frame.type === "tool_execution_start" && frame.toolCallId === "call_1"),
			{ timeout: 30_000 },
		)
		.toBe(true);
	return { provider, session };
}

/** Resolves once a main-agent request carries `text`, with the result of shell call `id` beside it. */
async function readWith(provider: Provider, session: Omp, text: string, id: string): Promise<void> {
	await expect.poll(() => provider.bodies.some(body => body.includes(text)), { timeout: 30_000 }).toBe(true);
	expect(resultOf(session.frames, id)).toContain(EARLY);
	expect(session.frames.find(frame => frame.type === "tool_execution_end" && frame.toolCallId === id)?.isError).toBe(
		false,
	);
}

const aside = async (session: Omp, text: string) =>
	expect(await session.bridge.request("agent_control.aside", { message: wrapAgentMessage(text, "Other") })).toEqual(
		{},
	);

describe.skipIf(!existsSync(omp))("a message reaches a session whose turn runs a long shell command, now", () => {
	it("the person's steer: the command backgrounds and the next request carries it", async () => {
		const { provider, session } = await inShell();
		expect((await session.send({ type: "steer", message: "person-now" })).success).toBe(true);
		await readWith(provider, session, "person-now", "call_1");
	}, 120_000);

	it("another session's message: the command backgrounds and the next request carries it", async () => {
		const { provider, session } = await inShell();
		await aside(session, "agent-now");
		await readWith(provider, session, "agent-now", "call_1");
	}, 120_000);

	it("a done report: the command backgrounds and the next request carries it", async () => {
		const { provider, session } = await inShell();
		expect(await session.bridge.request("agent_control.mail", mail("done", "done-now"))).toEqual({});
		await readWith(provider, session, "done-now", "call_1");
	}, 120_000);
});

describe.skipIf(!existsSync(omp))("a message sent during a long reply that then runs a shell command", () => {
	async function replying(): Promise<{ provider: Provider; session: Omp }> {
		const { provider, session } = await started();
		await session.send({ type: "prompt", message: HELD_SHELL });
		await provider.held;
		return { provider, session };
	}

	it("the person's steer is read at the reply's end, before the command it called finishes", async () => {
		const { provider, session } = await replying();
		expect((await session.send({ type: "steer", message: "person-during-reply" })).success).toBe(true);
		provider.release();
		await readWith(provider, session, "person-during-reply", "call_held");
	}, 120_000);

	it("another session's message is read at the reply's end, before the command it called finishes", async () => {
		const { provider, session } = await replying();
		await aside(session, "agent-during-reply");
		provider.release();
		await readWith(provider, session, "agent-during-reply", "call_held");
	}, 120_000);
});
