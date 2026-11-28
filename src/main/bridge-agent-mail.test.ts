/**
 * gui-bridge agent-control.ts `agent_control.mail`: a report from another session becomes one stock custom message
 * (`pi.sendMessage`, customType `ompdesk.mail`) with the delivery main chose; a no-turn report that finds a turn running
 * goes as an `aside` (read at the next step boundary), one to an idle session keeps stock's plain delivery (an aside
 * would start a turn); a report whose id the session's journal (or this process) already holds is never sent twice.
 * A report that asks for a turn makes stock's tool batch treat it as urgent (a running shell backgrounds itself); a
 * progress report or a note never does. The installed omp's side of it: bridge-agent-mail-stock.test.ts and
 * bridge-steer-now-stock.test.ts.
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { install, methods } from "../../resources/gui-bridge/agent-control";
import { MAIL_CUSTOM_TYPE } from "../../resources/gui-bridge/agent-control-contracts";
import { BOT_ENTRY, BOT_HOME_OBSERVATION } from "../../resources/gui-bridge/modes/bots-contracts";

type BridgeEnv = Parameters<NonNullable<(typeof methods)[string]>>[1];

const sendMessage = vi.fn();
/** The hooks `install` puts on stock's events, by event name. */
const hooks = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
/** Stock's `pi.on` takes every event's own handler; this fake keeps them all by name. */
const on = (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
	hooks.set(event, [...(hooks.get(event) ?? []), handler]);
};
install({ on: on as Parameters<typeof install>[0]["on"], sendMessage });
/** What stock emits as it hands a queued message to the model at a step boundary. */
const handedOver = (message: unknown) => {
	for (const hook of hooks.get("message_end") ?? [])
		hook({ type: "message_end", message }, { agent: { kind: "main" } });
};

/** Stock agent-core's peeks the tool batch polls (`Agent.hasIrcInterrupts`, `Agent.hasQueuedAsides`). */
interface Peeks {
	hasIrcInterrupts?: () => boolean | Promise<boolean>;
	hasQueuedAsides?: () => boolean | Promise<boolean>;
}

function env(
	session: {
		isStreaming?: boolean;
		branch?: unknown[];
		entries?: unknown[];
		agent?: Peeks;
		flush?: () => Promise<void>;
	} = {},
): BridgeEnv {
	const branch = session.branch ?? [];
	const agent = session.agent ?? {};
	return {
		session: () => ({
			isStreaming: session.isStreaming ?? false,
			sessionId: "s1",
			sessionManager: {
				getCwd: () => "/bot",
				getSessionId: () => "s1",
				getSessionFile: () => "/sessions/s1.jsonl",
				getBranch: () => branch,
				getEntries: () => session.entries ?? branch,
				flush: session.flush ?? (async () => {}),
			},
			agent,
		}),
		emit: () => undefined,
	} as unknown as BridgeEnv;
}

const mail = methods["agent_control.mail"];

afterEach(() => {
	sendMessage.mockReset();
	// Each case is a turn of its own: stock's agent_end ends it.
	for (const hook of hooks.get("agent_end") ?? []) hook({ type: "agent_end" }, { agent: { kind: "main" } });
});

describe("agent_control.mail", () => {
	it("hands the report to stock sendMessage with main's delivery", async () => {
		await mail?.(
			{ content: "<ompdesk-mail …>", details: { id: "m1", kind: "done" }, triggerTurn: true, deliverAs: "aside" },
			env(),
		);
		expect(sendMessage).toHaveBeenLastCalledWith(
			{
				customType: MAIL_CUSTOM_TYPE,
				content: expect.stringContaining("<ompdesk-mail …>"),
				display: true,
				details: { id: "m1", kind: "done" },
			},
			{ triggerTurn: true, deliverAs: "aside" },
		);
	});

	it("drops a report the journal already holds, and one this process already handed to stock", async () => {
		const journaled = env({
			branch: [{ type: "custom_message", customType: MAIL_CUSTOM_TYPE, details: { id: "m2" } }],
		});
		expect(await mail?.({ content: "x", details: { id: "m2" }, triggerTurn: true }, journaled)).toEqual({
			duplicate: true,
			journaled: true,
		});
		await mail?.({ content: "x", details: { id: "m3" }, triggerTurn: false }, env());
		expect(await mail?.({ content: "x", details: { id: "m3" }, triggerTurn: false }, env())).toEqual({
			duplicate: true,
			journaled: false,
		});
		expect(sendMessage).toHaveBeenCalledTimes(1);
	});

	it("refuses a switched recipient and finds metered mail outside the current branch", async () => {
		const send = (sessionId: string) =>
			mail!(
				{
					content: "report",
					triggerTurn: true,
					details: { id: "counted", quotaRecipient: { sessionId, sessionPath: "/sessions/s1.jsonl" } },
				},
				env({ entries: [{ type: "custom_message", customType: MAIL_CUSTOM_TYPE, details: { id: "counted" } }] }),
			);
		await expect(send("s2")).rejects.toThrow("session changed");
		await expect(send("s1")).resolves.toEqual({ duplicate: true, journaled: true });
		expect(sendMessage).not.toHaveBeenCalled();
	});

	it("checks the expected home and active bot branch at delivery, without journaling private routing data", async () => {
		const live = { cwd: "/bot", sessionId: "s1", sessionPath: "/sessions/s1.jsonl" };
		const home = { ...live, botId: "bot-1" };
		const branch = [
			{
				type: "custom",
				customType: BOT_ENTRY,
				data: { bot: { id: "bot-1", name: "Bot", folder: "/bot", firstRun: true } },
			},
		];
		const send = (peerBotHome: unknown, branchEntries: unknown[]) =>
			mail!(
				{
					content: "First message",
					triggerTurn: true,
					details: { id: "peer-kickoff-1", peerBotHome },
				},
				env({ branch: branchEntries }),
			);
		await expect(send({ ...home, sessionId: "moved" }, branch)).rejects.toThrow("home chat changed");
		await expect(send(home, [])).rejects.toThrow("active branch");
		expect(sendMessage).not.toHaveBeenCalled();
		await send(home, branch);
		expect(sendMessage).toHaveBeenCalledExactlyOnceWith(
			{
				customType: MAIL_CUSTOM_TYPE,
				content: expect.stringContaining("First message"),
				display: true,
				details: { id: "peer-kickoff-1" },
			},
			{ triggerTurn: true },
		);
		const inspect = methods[BOT_HOME_OBSERVATION]!;
		await expect(inspect({ id: "peer-kickoff-1" }, env({ branch }))).resolves.toEqual({
			...live,
			journaled: false,
			queued: true,
		});
		// A fork may no longer show the message. The receipt belongs to the whole flushed journal, not its visible branch.
		const entry = { type: "custom_message", customType: MAIL_CUSTOM_TYPE, details: { id: "peer-kickoff-1" } };
		const flushed = Promise.withResolvers<void>();
		const flush = vi.fn(() => flushed.promise);
		const ack = inspect({ id: "peer-kickoff-1" }, env({ branch, entries: [entry, ...branch], flush }));
		expect(flush).toHaveBeenCalledOnce();
		flushed.resolve();
		await expect(ack).resolves.toMatchObject({ ...live, journaled: true });
	});

	it("sends a no-turn report as an aside while a turn runs, and plainly to an idle session", async () => {
		const busy = env({ isStreaming: true });
		await mail?.({ content: "busy", details: { id: "m4", kind: "progress" }, triggerTurn: false }, busy);
		expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ content: "busy" }), {
			triggerTurn: false,
			deliverAs: "aside",
		});
		await mail?.({ content: "idle", details: { id: "m5", kind: "note" }, triggerTurn: false }, env());
		expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ content: "idle" }), {
			triggerTurn: false,
		});
	});

	it("never passes on a delivery that would cut a running tool batch (an older main's followUp)", async () => {
		await mail?.(
			{ content: "old", details: { id: "m6", kind: "done" }, triggerTurn: true, deliverAs: "followUp" },
			env({ isStreaming: true }),
		);
		expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ content: "old" }), {
			triggerTurn: true,
			deliverAs: "aside",
		});
	});

	it("makes a report that asks for a turn urgent until stock hands it over; progress never", async () => {
		// Stock's aside queue, filled by sendMessage and drained whole at a step boundary.
		const queue: { customType: string; content: string; details: unknown }[] = [];
		sendMessage.mockImplementation(message => queue.push(message));
		const agent: Peeks = { hasIrcInterrupts: () => false, hasQueuedAsides: () => queue.length > 0 };
		const busy = env({ isStreaming: true, agent });
		await mail?.({ content: "status", details: { id: "u1", kind: "progress" }, triggerTurn: false }, busy);
		expect(await agent.hasIrcInterrupts?.()).toBe(false);
		await mail?.({ content: "finished", details: { id: "u2", kind: "done" }, triggerTurn: true }, busy);
		expect(await agent.hasIrcInterrupts?.()).toBe(true);
		// The boundary takes both, and a progress report lands before the next tool batch looks again.
		for (const message of queue.splice(0)) handedOver({ role: "custom", ...message });
		await mail?.({ content: "status again", details: { id: "u3", kind: "progress" }, triggerTurn: false }, busy);
		expect(await agent.hasIrcInterrupts?.()).toBe(false);
	});

	it("keeps the main agent's urgent report when one of its subagents ends a turn", async () => {
		// index.ts installs every area module again on each subagent's `pi` (a rebind); its hooks see that subagent.
		const child = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
		const onChild = (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			child.set(event, [...(child.get(event) ?? []), handler]);
		};
		install({ on: onChild as Parameters<typeof install>[0]["on"], sendMessage });
		const queue: unknown[] = [];
		sendMessage.mockImplementation(message => queue.push(message));
		const agent: Peeks = { hasIrcInterrupts: () => false, hasQueuedAsides: () => queue.length > 0 };
		const busy = env({ isStreaming: true, agent });
		await mail?.({ content: "question", details: { id: "c1", kind: "question" }, triggerTurn: true }, busy);
		for (const hook of child.get("agent_end") ?? []) hook({ type: "agent_end" }, { agent: { kind: "task" } });
		for (const hook of child.get("message_end") ?? [])
			hook(
				{ type: "message_end", message: { role: "custom", customType: MAIL_CUSTOM_TYPE, details: { id: "c1" } } },
				{ agent: { kind: "task" } },
			);
		expect(await agent.hasIrcInterrupts?.()).toBe(true);
	});
});

it("fences item mail, preserves its queued aside, and acknowledges the flushed session journal on retry", async () => {
	const receive = methods["agent_control.item_mail"]!;
	const entries: unknown[] = [];
	const flush = vi.fn(async () => {});
	const receiver = env({ entries, isStreaming: true, flush });
	const command = {
		item: "item-a",
		generation: 3,
		session: "/sessions/s1.jsonl",
		key: "a".repeat(64),
		message: "log",
	};
	await expect(receive(command, receiver)).rejects.toThrow("does not authorize");
	const check = vi.fn(async () => false);
	receiver.itemFence = { check };
	await expect(receive(command, receiver)).rejects.toThrow("does not authorize");
	check.mockResolvedValue(true);
	await expect(receive({ ...command, session: "/wrong" }, receiver)).rejects.toThrow();
	expect(sendMessage).not.toHaveBeenCalled();
	for (let i = 0; i < 2; i++)
		await expect(receive(command, receiver)).resolves.toEqual({ key: command.key, journaled: false });
	expect(check).toHaveBeenLastCalledWith(command.session, {
		item: command.item,
		generation: 3,
		key: command.key,
		fingerprint: createHash("sha256").update(command.message).digest("hex"),
	});
	expect(sendMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ content: "log" }), {
		triggerTurn: true,
		deliverAs: "aside",
	});
	const probe = methods["agent_control.sent"]!;
	const mark = `item-mail:${command.key}:${createHash("sha256").update(command.session).digest("hex")}`;
	await expect(probe({ marks: [mark] }, receiver)).resolves.toMatchObject({
		matches: true,
		queued: true,
		journaled: [],
	});
	await expect(probe({ marks: [`item-mail:${command.key}:${"0".repeat(64)}`] }, receiver)).resolves.toMatchObject({
		matches: false,
		queued: false,
		journaled: [],
	});
	entries.push({ type: "custom_message", customType: MAIL_CUSTOM_TYPE, details: { id: `item-mail:${command.key}` } });
	await expect(receive(command, receiver)).resolves.toEqual({ key: command.key, journaled: true });
	expect(flush).toHaveBeenCalledOnce();
	expect(sendMessage).toHaveBeenCalledOnce();
	await expect(probe({ marks: [mark] }, receiver)).resolves.toMatchObject({ matches: true, journaled: [mark] });
});

describe("agent_control.sent", () => {
	const sent = methods["agent_control.sent"];
	const user = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });

	it("names the markers a prompt the journal holds carries, and the omp process that answers", async () => {
		const branch = [
			user('Also do C\n\n[ompdesk dispatch d2: report with ompdesk_report, dispatch "d2"]'),
			// Quoted by the agent or a report, a marker is no message the session took.
			{ type: "message", message: { role: "assistant", content: "[ompdesk dispatch d3: …]" } },
			{ type: "custom_message", customType: MAIL_CUSTOM_TYPE, content: "[ompdesk request m-1]" },
			{ type: "message", message: { role: "user", content: "plain [ompdesk request q7]" } },
		];
		const marks = ["[ompdesk dispatch d2:", "[ompdesk dispatch d3:", "[ompdesk request m-1]", "[ompdesk request q7]"];
		const answer = (await sent?.({ marks }, env({ branch }))) as { instance: string; journaled: string[] };
		expect(answer.journaled).toEqual(["[ompdesk dispatch d2:", "[ompdesk request q7]"]);
		expect(answer.instance).toContain(String(process.pid));
		// The same process answers the same instance: a message handed to it is never handed again.
		expect(((await sent?.({ marks: [] as string[] }, env())) as { instance: string } | undefined)?.instance).toBe(
			answer.instance,
		);
	});
});
