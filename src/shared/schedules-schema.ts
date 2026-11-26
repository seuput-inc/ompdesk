/**
 * The schedules' shapes as the paired-host protocol carries them (zod, `main/remote/app-protocol.ts`). The rules a
 * draft must keep are `scheduleDraftProblem`'s, checked by the service that saves it.
 */
import { z } from "zod";
import {
	GITHUB_EVENT_KINDS,
	SCHEDULE_THINKING_LEVELS,
	type ScheduleEvent,
	type ScheduleFrequency,
	type ScheduleRun,
	SESSION_EVENT_KINDS,
	WEBHOOK_SENDERS,
	WEBHOOK_WHERE_OPS,
	type WebhookCall,
} from "./schedules";

const Path = z.string().max(4096);
const Short = z.string().max(200);

export const ScheduleEventSchema: z.ZodType<ScheduleEvent> = z.discriminatedUnion("source", [
	z.object({
		source: z.literal("webhook"),
		key: Short,
		previousKey: z.object({ key: Short, until: z.string().max(40) }).optional(),
		signedBy: z.enum(WEBHOOK_SENDERS).optional(),
		where: z
			.array(z.object({ path: Short, op: z.enum(WEBHOOK_WHERE_OPS), values: z.array(Short).max(10).optional() }))
			.max(8)
			.optional(),
		contains: Short.optional(),
		pick: z.array(Short).max(12).optional(),
	}),
	z.object({
		source: z.literal("github"),
		repo: Short,
		events: z.array(z.enum(GITHUB_EVENT_KINDS)).max(GITHUB_EVENT_KINDS.length),
		from: z.array(Short).max(20).optional(),
		contains: Short.optional(),
		label: Short.optional(),
	}),
	z.object({ source: z.literal("files"), path: Path }),
	z.object({ source: z.literal("git"), repo: Path, branch: z.string().max(250) }),
	z.object({
		source: z.literal("session"),
		events: z.array(z.enum(SESSION_EVENT_KINDS)).max(SESSION_EVENT_KINDS.length),
		folder: z.string().max(4096).optional(),
	}),
	z.object({
		source: z.literal("email"),
		account: z.string().max(200),
		from: z.string().max(200).optional(),
		subject: z.string().max(200).optional(),
		to: z.string().max(200).optional(),
	}),
	z.object({ source: z.literal("calendar"), url: z.string().max(2000), leadMinutes: z.number().int() }),
]);

export const ScheduleFrequencySchema: z.ZodType<ScheduleFrequency> = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("interval"), minutes: z.number().int() }),
	z.object({ kind: z.literal("daily"), time: z.string().max(5), days: z.array(z.number().int()).max(7) }),
	z.object({ kind: z.literal("once"), at: z.string().max(40) }),
	z.object({ kind: z.literal("cron"), expr: z.string().max(200) }),
	z.object({ kind: z.literal("event"), event: ScheduleEventSchema, by: z.string().max(40).optional() }),
]);

export const ScheduleThinkingSchema = z.enum(SCHEDULE_THINKING_LEVELS);

export const WebhookCallSchema: z.ZodType<WebhookCall> = z.object({
	id: z.string(),
	at: z.string(),
	verdict: z.enum(["started", "queued", "ignored", "duplicate", "refused", "off"]),
	reason: z.string().optional(),
	run: z.string().optional(),
	sample: z.literal(true).optional(),
	count: z.number().optional(),
});

export const ScheduleRunSchema: z.ZodType<ScheduleRun> = z.object({
	id: z.string(),
	scheduleId: z.string(),
	trigger: z.enum(["schedule", "manual", "event"]),
	startedAt: z.string(),
	endedAt: z.string().nullable(),
	status: z.enum(["running", "succeeded", "failed", "stopped", "skipped"]),
	exitCode: z.number().nullable(),
	error: z.string().nullable(),
	detail: z.string().optional(),
	repeats: z.number().optional(),
	notStarted: z.boolean().optional(),
	resentAs: z.string().optional(),
	usage: z
		.object({
			input: z.number(),
			output: z.number(),
			cacheRead: z.number(),
			cacheWrite: z.number(),
			cost: z.number(),
		})
		.optional(),
	session: z.string().optional(),
	worktree: z.string().optional(),
});
