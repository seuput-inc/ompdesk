/**
 * OMPdesk control tools (src/main/agent-control/): the confirmation card a risky tool call waits for, and the note
 * an answered session keeps. Main asks the calling tab's omp (a paired host's tab: on the host, so the card reaches
 * the device like any other approval) and the bridge raises stock's own extension-UI `confirm`
 * (gui-bridge agent-control.ts). Not stock commands and never sent by a renderer.
 */

import { z } from "zod";
import { ATTACHMENT_MAX_BYTES } from "../../../resources/gui-bridge/agent-control-contracts";
import { BOT_METHOD, type BotContext } from "../../../resources/gui-bridge/modes/bots-contracts";
import type { LocalHandler } from "./types";

const confirmCommand = z.object({ title: z.string().min(1).max(200), message: z.string().min(1).max(2000) });
const noteCommand = z.object({ text: z.string().min(1).max(500) });
const workerCommand = z.object({ from: z.string().min(1).max(200) });
const botItem = z.object({
	number: z.number().int().min(1),
	title: z.string().max(200),
	status: z.string().max(20),
	question: z
		.object({
			text: z.string().max(8_000),
			options: z.array(z.string().max(200)).max(10),
			recommended: z.number().int().min(0).optional(),
		})
		.optional(),
});
const botCommand = z.object({
	context: z.object({
		bot: z.object({
			id: z.string().min(1).max(100),
			name: z.string().min(1).max(80),
			paused: z.boolean(),
			folder: z.string().min(1).max(4096),
			firstRun: z.boolean().default(false),
		}),
		items: z.array(botItem).max(1000),
		needsYou: z.array(botItem).max(1000),
		live: z.array(z.string().max(500)).max(100),
	}),
	/** The newest kickoff's mail id, for the first run's facts (`BotChatFacts`). */
	kickoff: z.string().min(1).max(100).optional(),
});
const sentCommand = z.object({ marks: z.array(z.string().min(1).max(200)).min(1).max(100) });
const judgeCommand = z.object({ system: z.string().min(1).max(20_000), user: z.string().min(1).max(200_000) });
const attachmentCommand = z
	.object({ path: z.string().trim().min(1).max(4096).optional(), image: z.number().int().min(1).optional() })
	.refine(command => (command.path === undefined) !== (command.image === undefined), {
		message: "an attachment is {path} or {image}, one of them",
	});
const imageBlock = z.object({
	type: z.literal("image"),
	data: z
		.string()
		.min(1)
		.max(Math.ceil(ATTACHMENT_MAX_BYTES / 3) * 4),
	mimeType: z.string().min(1).max(100),
});
const mailBlocks = z.array(z.union([z.object({ type: z.literal("text"), text: z.string().max(200_000) }), imageBlock]));
const asideCommand = z.object({ message: z.string().min(1).max(200_000), images: z.array(imageBlock).optional() });
const mailCommand = z.object({
	// A report with pictures sent along is text blocks and image blocks (stock's `(TextContent | ImageContent)[]`).
	content: z.union([z.string().min(1).max(200_000), mailBlocks.min(1)]),
	details: z.record(z.string(), z.unknown()),
	triggerTurn: z.boolean(),
	// `followUp`: what a paired device's older main still sends; the bridge turns it into an aside while a turn runs.
	deliverAs: z.enum(["followUp", "aside"]).optional(),
});

export const handlers: Record<string, LocalHandler> = {
	agent_control_confirm: async (command, ctx) => {
		const { title, message } = confirmCommand.parse(command);
		const { approved } = await ctx.bridge.request<{ approved: boolean }>("agent_control.confirm", { title, message });
		return { approved: approved === true };
	},
	/** What a message carries besides text is read where the caller's omp runs (bridge `agent_control.attachment`). */
	agent_control_attachment: async (command, ctx) => {
		const { path, image } = attachmentCommand.parse(command);
		return ctx.bridge.request("agent_control.attachment", path === undefined ? { image } : { path });
	},
	agent_control_note: async (command, ctx) => {
		const { text } = noteCommand.parse(command);
		await ctx.bridge.request("agent_control.note", { text });
		return {};
	},
	/**
	 * A bot chat's context (the core's bot pass): its bridge journals it when it changed and answers what the branch
	 * says for the first run (`modes/bots.ts`).
	 */
	agent_control_bot: async (command, ctx) => {
		const { context, kickoff } = botCommand.parse(command);
		const payload: BotContext = context;
		return ctx.bridge.request(BOT_METHOD, kickoff ? { ...payload, kickoff } : payload);
	},
	/** The session was opened by another session's agent: its bridge journals it and adds the worker contract. */
	agent_control_worker: async (command, ctx) => {
		const { from } = workerCommand.parse(command);
		await ctx.bridge.request("agent_control.worker", { from });
		return {};
	},
	/** Whether the person's own typed message started this tab's current run (gui-bridge turn-origin.ts). */
	agent_control_turn: async (_command, ctx) => {
		const { person } = await ctx.bridge.request<{ person?: unknown }>("agent_control.turn", {});
		return { person: person === true };
	},
	/**
	 * `ompdesk_compare` with criteria: one request on the `advisor` role, else `slow`, preferring a model family other
	 * than the caller's; main built the evidence.
	 */
	agent_control_judge: async (command, ctx) => {
		const { system, user } = judgeCommand.parse(command);
		return ctx.bridge.request("agent_control.judge", { system, user });
	},
	/**
	 * A report another session sent this one (`ompdesk_report`): its bridge hands it to stock `sendMessage`. Answers
	 * what the bridge did (`{duplicate, journaled}` for an id it already holds or queued).
	 */
	agent_control_mail: async (command, ctx) => {
		const mail = mailCommand.parse(command);
		return ctx.bridge.request("agent_control.mail", mail);
	},
	/**
	 * Another session's message to this one (`ompdesk_session_send`) while it works: its bridge hands it to stock as an
	 * aside, read with every other one waiting at the next step boundary. `{idle: true}`: nothing sent, the caller
	 * sends the plain prompt that starts the turn.
	 */
	agent_control_aside: async (command, ctx) => {
		const { message, images } = asideCommand.parse(command);
		return ctx.bridge.request("agent_control.aside", images ? { message, images } : { message });
	},
	/**
	 * Which message markers main sent this session (`[ompdesk dispatch d2:`, `[ompdesk request <id>]`) its journal
	 * holds, and which omp process answers (`{instance, journaled}`): main sends a message again only to a new omp.
	 */
	agent_control_sent: async (command, ctx) => {
		const { marks } = sentCommand.parse(command);
		return ctx.bridge.request("agent_control.sent", { marks });
	},
};
